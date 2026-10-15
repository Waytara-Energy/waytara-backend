import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { deriveLoginToken, loginTokenMatches } from "../src/core/mqtt-login.js";
import { open, seal } from "../src/core/seal.js";
import { dnTopic, upTopic } from "../src/features/broker/topics.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const SITE = "51000000-0000-4000-8000-000000000001";
const ADMIN = "a0000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 9);
const otherKey = Buffer.alloc(32, 8);
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const verify: TokenVerifier = async (t) => {
  if (t !== "tok-admin") throw new TokenError("no");
  return { id: ADMIN, role: "authenticated" } satisfies AuthUser;
};

let app: FastifyInstance;
let db: FakeDb;
let store: FakeStore;
let port: number;
let clients: MqttClient[] = [];

async function addKey(equipmentId: string, k: Buffer): Promise<string> {
  return db.createKey({ equipmentId, kind: "gateway", ciphertext: vault.encrypt(k, { equipmentId, kind: "gateway" }), fingerprint: "abcdef012345", actor: ADMIN });
}

beforeEach(async () => {
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  db.addEquipment({ equipmentId: OTHER, siteId: SITE });
  db.manage.add(`${ADMIN}|${EQ}`).add(`${ADMIN}|${OTHER}`);
  await addKey(EQ, key);
  await addKey(OTHER, otherKey);
  store = new FakeStore();
  app = await testApp({}, { db, verify, vault, store });
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.endAsync(true).catch(() => undefined)));
  clients = [];
  await app.close();
});

const connect = async (over: Partial<IClientOptions> = {}): Promise<MqttClient> => {
  const c = await mqtt.connectAsync(`ws://127.0.0.1:${port}/mqtt`, {
    clientId: `gw-${EQ}`,
    username: EQ,
    password: deriveLoginToken(key, EQ),
    reconnectPeriod: 0,
    connectTimeout: 4000,
    protocolVersion: 4,
    clean: true,
    ...over,
  });
  clients.push(c);
  return c;
};
const refused = async (over: Partial<IClientOptions>): Promise<boolean> => {
  try {
    await connect(over);
    return false;
  } catch {
    return true;
  }
};
const closes = (c: MqttClient, ms = 3000) => new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), ms); c.once("close", () => { clearTimeout(t); resolve(true); }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await wait(25);
  return check();
}
const deniedSubscribe = async (c: MqttClient, topic: string): Promise<boolean> => {
  try {
    const g = await c.subscribeAsync(topic, { qos: 1 });
    return g.every((x) => x.qos === 128);
  } catch {
    return true;
  }
};

describe("login", () => {
  it("lets a board in with its equipment id and the token derived from its key", async () => {
    const c = await connect();
    expect(c.connected).toBe(true);
  });

  it("refuses everything else the same way", async () => {
    const ok = deriveLoginToken(key, EQ);
    expect(await refused({ password: "wrong" })).toBe(true);
    expect(await refused({ password: undefined })).toBe(true);
    expect(await refused({ password: ok.slice(0, -1) + (ok.endsWith("A") ? "B" : "A") })).toBe(true);
    expect(await refused({ password: key.toString("base64url") })).toBe(true); // the key itself is not the password
    expect(await refused({ clientId: "gw-someone-else" })).toBe(true);
    expect(await refused({ clientId: `gw-${OTHER}` })).toBe(true);
    expect(await refused({ username: "not-a-uuid" })).toBe(true);
    expect(await refused({ username: OTHER })).toBe(true); // its own id, but another board's token
    expect(await refused({ username: "cccccccc-0000-4000-8000-000000000003", clientId: "gw-cccccccc-0000-4000-8000-000000000003" })).toBe(true); // no key at all
  });

  it("only accepts a last-will on the board's own presence topic", async () => {
    expect(await refused({ will: { topic: `wt/v1/${OTHER}/up/state`, payload: Buffer.from("offline"), qos: 1, retain: true } })).toBe(true);
    expect(await refused({ will: { topic: `wt/v1/${EQ}/up/data`, payload: Buffer.from("x"), qos: 1, retain: false } })).toBe(true);
    const c = await connect({ will: { topic: `wt/v1/${EQ}/up/state`, payload: Buffer.from("offline"), qos: 1, retain: true } });
    expect(c.connected).toBe(true);
  });

  it("replaces an older connection of the same board", async () => {
    const first = await connect();
    const gone = closes(first);
    await connect();
    expect(await gone).toBe(true);
  });

  it("stops accepting a source address after too many failed logins, even with the right token", async () => {
    for (let i = 0; i < 10; i++) await refused({ password: `wrong-${i}` });
    expect(await refused({})).toBe(true);
  });

  it("records a refused login for a real equipment in the audit trail, once", async () => {
    await refused({ password: "wrong" });
    await refused({ password: "wrong-again" });
    await wait(150);
    expect(db.events.filter((e) => e.event === "auth_failed")).toHaveLength(1);
  });

  it("compares tokens without leaking where they differ", () => {
    const t = deriveLoginToken(key, EQ);
    expect(loginTokenMatches(t, Buffer.from(t))).toBe(true);
    expect(loginTokenMatches(t, Buffer.from(t.slice(1)))).toBe(false);
    expect(loginTokenMatches(t, undefined)).toBe(false);
  });
});

describe("topics", () => {
  it("lets a board read only its own downlink topics, never a wildcard", async () => {
    const c = await connect();
    for (const t of ["#", "wt/v1/#", "wt/v1/+/dn/#", `wt/v1/${EQ}/#`, `wt/v1/${OTHER}/dn/map`, `wt/v1/${EQ}/up/data`, "$SYS/#"]) expect(await deniedSubscribe(c, t), t).toBe(true);
    const g = await c.subscribeAsync([dnTopic(EQ, "ack"), dnTopic(EQ, "cmd"), dnTopic(EQ, "map")], { qos: 1 });
    expect(g.every((x) => x.qos === 1)).toBe(true);
  });

  it("disconnects a board that publishes to another board's topic", async () => {
    const c = await connect();
    const gone = closes(c);
    c.publish(upTopic(OTHER, "hb"), Buffer.from("x"), { qos: 1 }, () => undefined);
    expect(await gone).toBe(true);
  });

  it("disconnects a board that publishes to a downlink topic or an unknown one", async () => {
    for (const topic of [dnTopic(EQ, "ack"), `wt/v1/${EQ}/up/whatever`, "anything/else"]) {
      const c = await connect();
      const gone = closes(c);
      c.publish(topic, Buffer.from("x"), { qos: 1 }, () => undefined);
      expect(await gone, topic).toBe(true);
    }
  });

  it("disconnects a board that sends an oversized message", async () => {
    const c = await connect();
    const gone = closes(c);
    c.publish(upTopic(EQ, "data"), Buffer.alloc(65 * 1024, 1), { qos: 1 }, () => undefined);
    expect(await gone).toBe(true);
  });
});

describe("a board talking to the data intake", () => {
  it("has its register map delivered, sealed, as soon as it subscribes", async () => {
    const c = await connect();
    const got = new Promise<Buffer>((resolve) => c.on("message", (_t, p) => resolve(p)));
    await c.subscribeAsync(dnTopic(EQ, "map"), { qos: 1 });
    const map = open<{ ver: number; requests: unknown[]; writes: unknown[] }>(await got, { equipmentKey: key, equipmentId: EQ, direction: "dn", topic: dnTopic(EQ, "map") }).body;
    expect(map.ver).toBe(1);
    expect(map.requests.length).toBeGreaterThan(40);
    expect(map.writes.length).toBeGreaterThan(20);
  });

  it("gets a sealed heartbeat through to storage", async () => {
    const c = await connect();
    const body = { boot: 5, uptime_s: 42, inverter_online: true, map_ver: 1, fw_version: "2.0.1", rssi: -58 };
    c.publish(upTopic(EQ, "hb"), seal(body, { equipmentKey: key, equipmentId: EQ, direction: "up", topic: upTopic(EQ, "hb"), counter: 1 }), { qos: 1 });
    expect(await until(() => store.heartbeats.length === 1)).toBe(true);
    expect(store.heartbeats[0]).toMatchObject({ equipmentId: EQ, boot: 5, inverterOnline: true, fwVersion: "2.0.1", rssi: -58 });
  });

  it("ignores a heartbeat sealed with some other key even though the login was right", async () => {
    const c = await connect();
    c.publish(upTopic(EQ, "hb"), seal({ boot: 5, uptime_s: 1 }, { equipmentKey: otherKey, equipmentId: EQ, direction: "up", topic: upTopic(EQ, "hb"), counter: 1 }), { qos: 1 });
    await wait(300);
    expect(store.heartbeats).toHaveLength(0);
  });

  it("does not let one board's login read or write another board's data", async () => {
    const a = await connect();
    const b = await connect({ clientId: `gw-${OTHER}`, username: OTHER, password: deriveLoginToken(otherKey, OTHER) });
    const seen: string[] = [];
    b.on("message", (t) => seen.push(t));
    await b.subscribeAsync(dnTopic(OTHER, "ack"), { qos: 1 });
    await a.subscribeAsync(dnTopic(EQ, "ack"), { qos: 1 });
    await wait(200);
    expect(seen.every((t) => t.includes(OTHER))).toBe(true);
  });
});

describe("keys changing while a board is connected", () => {
  const api = (method: "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url, headers: { authorization: "Bearer tok-admin" }, ...(payload ? { payload } : {}) });

  it("drops a board within seconds when its key is revoked", async () => {
    const c = await connect();
    const gone = closes(c, 2500);
    const id = db.keys.find((k) => k.equipmentId === EQ)!.keyId;
    expect((await api("DELETE", `/v1/keys/${id}`)).json()).toEqual({ revoked: true });
    expect(await gone).toBe(true);
    expect(await refused({})).toBe(true);
  });

  it("drops a board when its key is rotated with no grace, and accepts the new token", async () => {
    const c = await connect();
    const gone = closes(c, 2500);
    const id = db.keys.find((k) => k.equipmentId === EQ)!.keyId;
    const res = (await api("POST", `/v1/keys/${id}/rotate`, { grace_seconds: 0 })).json();
    expect(await gone).toBe(true);
    const fresh = Buffer.from(res.secret, "base64url");
    expect((await connect({ password: deriveLoginToken(fresh, EQ) })).connected).toBe(true);
    expect(await refused({})).toBe(true); // the old token no longer works
  });

  it("keeps the board connected during a grace period, with both tokens valid", async () => {
    const c = await connect();
    const id = db.keys.find((k) => k.equipmentId === EQ)!.keyId;
    const res = (await api("POST", `/v1/keys/${id}/rotate`, { grace_seconds: 120 })).json();
    await wait(200);
    expect(c.connected).toBe(true);
    const fresh = Buffer.from(res.secret, "base64url");
    expect((await connect({ password: deriveLoginToken(fresh, EQ) })).connected).toBe(true);
  });
});
