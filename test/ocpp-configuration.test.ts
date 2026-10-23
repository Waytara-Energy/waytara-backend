import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { KeyVault } from "../src/core/key-vault.js";
import { KeyChangeBus } from "../src/lib/key-events.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { MemoryObjectStore } from "../src/storage/object-store.js";
import { FakeDb } from "./fakes.js";
import { FakeEvStore } from "./fake-ev-store.js";
import { FakeStore } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "ca7809ea-cfc9-4dd3-aeba-cd245a84e7ca";
const SECRET = "k3x9q2m7p4w8z1n5v6c0b2d4";
const NAME = "WT_PZ_7k_1";
const OWNER = "c1000000-0000-4000-8000-000000000001";
const STRANGER = "c2000000-0000-4000-8000-000000000002";
const STAFF = "c3000000-0000-4000-8000-000000000003";
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const users: Record<string, AuthUser> = {
  "tok-owner": { id: OWNER, role: "authenticated" },
  "tok-stranger": { id: STRANGER, role: "authenticated" },
  "tok-staff": { id: STAFF, role: "authenticated" },
};
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};

let app: FastifyInstance;
let ev: FakeEvStore;
let port: number;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  ev = new FakeEvStore();
  ev.keys = [{ equipmentId: EQ, keyId: "kkkkkkkk-0000-4000-8000-000000000001", label: NAME, ciphertext: vault.encrypt(Buffer.from(SECRET, "utf8"), { equipmentId: EQ, kind: "charger" }), expiresAt: null }];
  ev.access_.set(`${OWNER}|${EQ}`, "owner");
  ev.access_.set(`${STAFF}|${EQ}`, "staff");
  app = await testApp({}, { db: new FakeDb(), verify, vault, store: new FakeStore(), evStore: ev, bus: new KeyChangeBus(), objectStore: new MemoryObjectStore() } as never);
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await app.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const as = (token: string) => ({ authorization: `Bearer ${token}` });

/** A charger connected straight to the hub that answers the server's calls with `reply` and keeps what it was asked. */
async function charger(reply: (action: string, payload: unknown) => unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${SECRET}/${NAME}`, "ocpp1.6");
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const asked: { action: string; payload: unknown }[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString()) as [number, string, string, unknown];
    if (m[0] === 2) {
      asked.push({ action: m[2], payload: m[3] });
      ws.send(JSON.stringify([3, m[1], reply(m[2], m[3])]));
    }
  });
  // the hub knows the connection once it has attached it
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const s = await app.inject({ method: "GET", url: `/v1/ev/${EQ}/status`, headers: as("tok-owner") });
    if ((s.json() as { connected: boolean }).connected) break;
    await wait(20);
  }
  return asked;
}

const read = (query = "", token = "tok-owner") => app.inject({ method: "GET", url: `/v1/ev/${EQ}/configuration${query}`, headers: as(token) });
const change = (body: object, token = "tok-staff") => app.inject({ method: "POST", url: `/v1/ev/${EQ}/configuration`, headers: as(token), payload: body });

const CONFIG = (action: string, payload: unknown): unknown => {
  if (action === "GetConfiguration") {
    const keys = (payload as { key?: string[] }).key;
    const all = [
      { key: "HeartbeatInterval", readonly: false, value: "30" },
      { key: "NumberOfConnectors", readonly: true, value: "1" },
      { key: "MeterValuesSampledData", readonly: false },
    ];
    const known = keys ? all.filter((c) => keys.includes(c.key)) : all;
    return { configurationKey: known, ...(keys ? { unknownKey: keys.filter((k) => !all.some((c) => c.key === k)) } : {}) };
  }
  return { status: "Accepted" };
};

describe("reading the charger's OCPP configuration", () => {
  it("lets the owner read it all, or just some keys, with the unknown ones named", async () => {
    const asked = await charger(CONFIG);
    const all = await read();
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({
      configuration: [
        { key: "HeartbeatInterval", value: "30", readonly: false },
        { key: "NumberOfConnectors", value: "1", readonly: true },
        { key: "MeterValuesSampledData", value: null, readonly: false },
      ],
      unknown: [],
    });
    expect(asked.at(-1)).toEqual({ action: "GetConfiguration", payload: {} });

    const some = await read("?keys=HeartbeatInterval,Nope");
    expect(some.json()).toEqual({ configuration: [{ key: "HeartbeatInterval", value: "30", readonly: false }], unknown: ["Nope"] });
    expect(asked.at(-1)).toEqual({ action: "GetConfiguration", payload: { key: ["HeartbeatInterval", "Nope"] } });
  });

  it("is closed to a stranger and to nobody signed in", async () => {
    await charger(CONFIG);
    expect((await read("", "tok-stranger")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/ev/${EQ}/configuration` })).statusCode).toBe(401);
  });

  it("refuses key names that are not plain, and too many keys", async () => {
    await charger(CONFIG);
    expect((await read("?keys=bad key")).statusCode).toBe(400);
    expect((await read("?keys=a;b")).statusCode).toBe(400);
    expect((await read(`?keys=${Array.from({ length: 21 }, (_, i) => `K${i}`).join(",")}`)).statusCode).toBe(400);
  });

  it("says plainly when the charger is not connected", async () => {
    const r = await read();
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("offline");
  });
});

describe("changing the charger's OCPP configuration", () => {
  it("lets staff change an allowed key, and keeps a record of it", async () => {
    const asked = await charger(CONFIG);
    const r = await change({ key: "HeartbeatInterval", value: "60" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "Accepted" });
    expect(asked.at(-1)).toEqual({ action: "ChangeConfiguration", payload: { key: "HeartbeatInterval", value: "60" } });
    expect(ev.events.find((e) => e.kind === "command" && (e.detail as { command?: string }).command === "change-configuration")!.detail).toMatchObject({ key: "HeartbeatInterval", value: "60", by: STAFF });
  });

  it("does not let the owner or a stranger change anything (they get what an unknown charger gets)", async () => {
    const asked = await charger(CONFIG);
    expect((await change({ key: "HeartbeatInterval", value: "60" }, "tok-owner")).statusCode).toBe(404);
    expect((await change({ key: "HeartbeatInterval", value: "60" }, "tok-stranger")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/ev/${EQ}/configuration`, payload: { key: "HeartbeatInterval", value: "60" } })).statusCode).toBe(401);
    expect(asked.some((a) => a.action === "ChangeConfiguration")).toBe(false);
  });

  it("refuses a key outside the list, with the list in the answer", async () => {
    const asked = await charger(CONFIG);
    const r = await change({ key: "AuthorizationKey", value: "secret" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/HeartbeatInterval/);
    expect(asked.some((a) => a.action === "ChangeConfiguration")).toBe(false);
  });

  it("refuses a value that does not fit its key", async () => {
    const asked = await charger(CONFIG);
    for (const [key, value] of [
      ["HeartbeatInterval", "4"],
      ["HeartbeatInterval", "3601"],
      ["HeartbeatInterval", "ten"],
      ["MeterValueSampleInterval", "-1"],
      ["ClockAlignedDataInterval", "86401"],
      ["ConnectionTimeOut", "4"],
      ["MeterValuesSampledData", "Voltage,Gold"],
      ["MeterValuesSampledData", "Voltage,Voltage"],
      ["StopTransactionOnEVSideDisconnect", "yes"],
    ] as const) {
      const r = await change({ key, value });
      expect(r.statusCode, `${key}=${value}`).toBe(400);
    }
    expect(asked.some((a) => a.action === "ChangeConfiguration")).toBe(false);
  });

  it("accepts good values of the other keys", async () => {
    const asked = await charger(CONFIG);
    for (const [key, value] of [
      ["MeterValueSampleInterval", "30"],
      ["ClockAlignedDataInterval", "0"],
      ["ConnectionTimeOut", "120"],
      ["MeterValuesSampledData", "Energy.Active.Import.Register,Power.Active.Import,Voltage,Current.Import"],
      ["StopTransactionOnEVSideDisconnect", "true"],
    ] as const) {
      expect((await change({ key, value })).statusCode, key).toBe(200);
    }
    expect(asked.filter((a) => a.action === "ChangeConfiguration")).toHaveLength(5);
  });

  it("passes on RebootRequired, and any other answer from the charger becomes Rejected", async () => {
    await charger((action) => (action === "ChangeConfiguration" ? { status: "RebootRequired" } : {}));
    expect((await change({ key: "HeartbeatInterval", value: "60" })).json()).toEqual({ status: "RebootRequired" });
    sockets.forEach((s) => s.terminate());
    await wait(100);

    await charger((action) => (action === "ChangeConfiguration" ? { status: "Whatever" } : {}));
    expect((await change({ key: "HeartbeatInterval", value: "60" })).json()).toEqual({ status: "Rejected" });
  });

  it("says plainly when the charger is not connected", async () => {
    const r = await change({ key: "HeartbeatInterval", value: "60" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("offline");
  });

  it("refuses a body of the wrong shape", async () => {
    await charger(CONFIG);
    expect((await change({})).statusCode).toBe(400);
    expect((await change({ key: "HeartbeatInterval" })).statusCode).toBe(400);
    expect((await change({ key: "bad key", value: "1" })).statusCode).toBe(400);
  });
});
