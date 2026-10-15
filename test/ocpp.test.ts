import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { KeyVault } from "../src/core/key-vault.js";
import { KeyChangeBus } from "../src/lib/key-events.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { gzipSync } from "node:zlib";
import { MemoryObjectStore } from "../src/storage/object-store.js";
import { FakeDb } from "./fakes.js";
import { FakeEvStore } from "./fake-ev-store.js";
import { FakeStore } from "./fake-store.js";
import { appWithLogCapture, testApp } from "./helpers.js";

const EQ = "ca7809ea-cfc9-4dd3-aeba-cd245a84e7ca";
const OTHER = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const SECRET = "k3x9q2m7p4w8z1n5v6c0b2d4";
const NAME = "WT_PZ_7k_1";
const OWNER = "c1000000-0000-4000-8000-000000000001";
const STRANGER = "c2000000-0000-4000-8000-000000000002";
const STAFF = "c3000000-0000-4000-8000-000000000003";
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const users: Record<string, AuthUser> = { "tok-owner": { id: OWNER, role: "authenticated" }, "tok-stranger": { id: STRANGER, role: "authenticated" }, "tok-staff": { id: STAFF, role: "authenticated" } };
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};

let app: FastifyInstance;
let ev: FakeEvStore;
let bus: KeyChangeBus;
let files: MemoryObjectStore;
let port: number;
let sockets: WebSocket[] = [];
const logs: string[] = [];

beforeEach(async () => {
  logs.length = 0;
  ev = new FakeEvStore();
  ev.keys = [{ equipmentId: EQ, keyId: "kkkkkkkk-0000-4000-8000-000000000001", label: NAME, ciphertext: vault.encrypt(Buffer.from(SECRET, "utf8"), { equipmentId: EQ, kind: "charger" }), expiresAt: null }];
  ev.access_.set(`${OWNER}|${EQ}`, "owner");
  ev.access_.set(`${STAFF}|${EQ}`, "staff");
  bus = new KeyChangeBus();
  files = new MemoryObjectStore();
  const db = new FakeDb();
  app = await testApp({}, { db, verify, vault, store: new FakeStore(), evStore: ev, bus, objectStore: files } as never);
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await app.close();
});

const url = (path: string) => `ws://127.0.0.1:${port}${path}`;
const open = (path: string, opts: ConstructorParameters<typeof WebSocket>[2] = {}) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url(path), "ocpp1.6", opts);
    sockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });

let counter = 0;
/** The charger side of a call: sends [2, id, action, payload] and resolves with the whole answer frame. */
function call(ws: WebSocket, action: string, payload: unknown): Promise<unknown[]> {
  const id = `c${++counter}`;
  return new Promise((resolve) => {
    const on = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as unknown[];
      if (m[1] === id && (m[0] === 3 || m[0] === 4)) {
        ws.off("message", on);
        resolve(m);
      }
    };
    ws.on("message", on);
    ws.send(JSON.stringify([2, id, action, payload]));
  });
}
/** Answers every call from the server with the given payload and keeps what it asked. */
function answerServerCalls(ws: WebSocket, reply: (action: string, payload: unknown) => unknown = () => ({ status: "Accepted" })) {
  const got: { action: string; payload: unknown }[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString()) as [number, string, string, unknown];
    if (m[0] === 2) {
      got.push({ action: m[2], payload: m[3] });
      ws.send(JSON.stringify([3, m[1], reply(m[2], m[3])]));
    }
  });
  return got;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await wait(20);
  return check();
}
const connect = () => open(`/ocpp/${SECRET}/${NAME}`);
const iso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();

const mv = (over: { kwh?: number; kw?: number; ts?: string } = {}) => ({
  connectorId: 1,
  transactionId: 1001,
  meterValue: [
    {
      timestamp: over.ts ?? iso(),
      sampledValue: [
        { value: String(over.kwh ?? 52.9), measurand: "Energy.Active.Import.Register", phase: "L1-N", unit: "kWh" },
        { value: String(over.kw ?? 3), measurand: "Power.Active.Import", phase: "L1-N", unit: "kW" },
        { value: "237.4", measurand: "Voltage", phase: "L1-N", unit: "V" },
        { value: "13.1", measurand: "Current.Import", phase: "L1-N", unit: "A" },
      ],
    },
  ],
});

describe("who may connect", () => {
  it("lets the right secret and name in, speaking ocpp1.6", async () => {
    const ws = await connect();
    expect(ws.protocol).toBe("ocpp1.6");
  });

  it("also accepts the name in the address with the secret as the Basic password", async () => {
    const ws = await open(`/ocpp/${NAME}`, { headers: { Authorization: `Basic ${Buffer.from(`${NAME}:${SECRET}`).toString("base64")}` } });
    expect(ws.protocol).toBe("ocpp1.6");
  });

  it("turns everything else away before the WebSocket starts, with the same plain answer", async () => {
    const attempts = [`/ocpp/${"x".repeat(24)}/${NAME}`, `/ocpp/${SECRET}/OTHER_NAME`, `/ocpp/${SECRET}/bad name!`, `/ocpp/short/${NAME}`, `/ocpp/${NAME}`];
    for (const a of attempts) await expect(open(a)).rejects.toMatchObject({ status: 404 });
    await expect(open(`/ocpp/${NAME}`, { headers: { Authorization: `Basic ${Buffer.from(`${NAME}:wrong-secret-here`).toString("base64")}` } })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a client that does not ask for ocpp1.6", async () => {
    const ws = new WebSocket(url(`/ocpp/${SECRET}/${NAME}`), "chat");
    sockets.push(ws);
    await expect(new Promise((_, reject) => { ws.once("error", reject); ws.once("open", () => reject(new Error("opened"))); })).rejects.toBeDefined();
  });

  it("slows down an address that keeps trying wrong secrets", async () => {
    let last = 0;
    for (let i = 0; i < 14; i++) {
      try {
        await open(`/ocpp/${"y".repeat(24)}/${NAME}`);
      } catch (e) {
        last = (e as { status: number }).status;
      }
    }
    expect(last).toBe(429);
    await expect(connect()).rejects.toMatchObject({ status: 429 }); // even the right secret, from that address, for a minute
  });

  it("never writes a secret, right or wrong, into a log line", async () => {
    const { app: logged, lines } = await appWithLogCapture({}, { db: new FakeDb(), verify, vault, store: new FakeStore(), evStore: ev } as never);
    await logged.listen({ host: "127.0.0.1", port: 0 });
    const p = (logged.server.address() as AddressInfo).port;
    const tryOpen = (path: string) =>
      new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p}${path}`, "ocpp1.6");
        sockets.push(ws);
        ws.once("open", () => resolve());
        ws.once("error", () => resolve());
        ws.once("unexpected-response", () => resolve());
      });
    await tryOpen(`/ocpp/${"z".repeat(24)}/${NAME}`);
    await tryOpen(`/ocpp/${SECRET}/${NAME}`);
    await wait(200);
    const text = lines.join("");
    expect(text).toContain("charger connection refused");
    expect(text).not.toContain("zzzzzzzz");
    expect(text).not.toContain(SECRET);
    await logged.close();
  });
});

describe("a charging session, as the real charger does it", () => {
  it("boots, reports, charges and stops: the session, its samples and its events are stored", async () => {
    const ws = await connect();
    const asked = answerServerCalls(ws);

    const boot = await call(ws, "BootNotification", { chargePointSerialNumber: "ME250004", chargePointModel: "MERDM12R01XXXX", chargePointVendor: "Plugzmart", firmwareVersion: "2.2.7", imsi: "", iccid: "" });
    expect(boot[0]).toBe(3);
    expect(boot[2]).toMatchObject({ status: "Accepted", interval: 30 });
    expect(await until(() => asked.length >= 3)).toBe(true); // it tells the charger how often to send meter values
    expect(asked.map((a) => a.action)).toEqual(["ChangeConfiguration", "ChangeConfiguration", "ChangeConfiguration"]);
    expect(asked[0]!.payload).toEqual({ key: "MeterValueSampleInterval", value: "30" });

    expect((await call(ws, "StatusNotification", { connectorId: 1, status: "Available", timestamp: iso(), errorCode: "NoError", info: "" }))[2]).toEqual({});
    expect((await call(ws, "Heartbeat", {}))[2]).toHaveProperty("currentTime");

    const auth = await call(ws, "Authorize", { idTag: "LOCAL_ADMIN" });
    expect(auth[2]).toEqual({ idTagInfo: { status: "Accepted" } });

    const start = await call(ws, "StartTransaction", { connectorId: 1, idTag: "LOCAL_ADMIN", meterStart: 52873, timestamp: iso(-120) });
    const tx = (start[2] as { transactionId: number }).transactionId;
    expect(tx).toBe(1001);
    expect((start[2] as { idTagInfo: { status: string } }).idTagInfo.status).toBe("Accepted");
    expect(ev.sessions).toHaveLength(1);
    expect(ev.sessions[0]).toMatchObject({ equipmentId: EQ, connector: 1, meterStartWh: 52873, chargePoint: NAME });
    expect(ev.sessions[0]!.idTagHash).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.sessions[0]!.idTagHash).not.toContain("LOCAL"); // the card id itself is never stored

    await call(ws, "MeterValues", mv({ ts: iso(-90), kwh: 52.9, kw: 3 }));
    await call(ws, "MeterValues", mv({ ts: iso(-60), kwh: 52.95, kw: 7.2 }));
    expect(ev.samples).toHaveLength(2);
    expect(ev.samples[1]!.sample).toMatchObject({ energy_kwh: 52.95, power_kw: 7.2, voltage_v_l1: 237.4, current_a_l1: 13.1 });

    const stop = await call(ws, "StopTransaction", { transactionId: tx, meterStop: 60873, timestamp: iso(), reason: "Local", idTag: "LOCAL_ADMIN" });
    expect(stop[2]).toEqual({ idTagInfo: { status: "Accepted" } });
    const s = ev.sessions[0]!;
    expect(s.endedAt).not.toBeNull();
    expect(s.meterStopWh).toBe(60873);
    expect(s.reason).toBe("Local");
    expect(s.summary).toMatchObject({ status: "completed", peak_power_kw: 7.2 });
    expect(ev.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["connected", "boot", "status", "authorize", "transaction_start", "transaction_stop"]));
  });

  it("stores the split of each sample when the inverter's figures are fresh", async () => {
    ev.figures = { pv_w: 2500, battery_w: 0, grid_w: 600, load_w: 3100, age_s: 4 };
    const ws = await connect();
    answerServerCalls(ws);
    await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: iso(-60) });
    await call(ws, "MeterValues", mv({ kw: 3 }));
    expect(ev.samples[0]!.sample).toMatchObject({ pv_w: 2500, grid_w: 600, site_load_w: 3100, ev_from_solar_w: 2500, ev_from_battery_w: 0, ev_from_grid_w: 500 });
  });

  it("leaves the site figures out when they are older than a minute, or missing", async () => {
    ev.figures = { pv_w: 2500, battery_w: 0, grid_w: 600, load_w: 3100, age_s: 300 };
    const ws = await connect();
    answerServerCalls(ws);
    await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: iso(-60) });
    await call(ws, "MeterValues", mv({ kw: 3 }));
    expect(ev.samples[0]!.sample).not.toHaveProperty("pv_w");
    expect(ev.samples[0]!.sample).not.toHaveProperty("ev_from_solar_w");
  });

  it("does not store meter values that belong to no transaction", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    const r = await call(ws, "MeterValues", { connectorId: 1, meterValue: [{ timestamp: iso(), sampledValue: [{ value: "1", unit: "kWh" }] }] });
    expect(r[0]).toBe(3);
    expect(ev.samples).toHaveLength(0);
  });

  it("finds the transaction by connector when a charger leaves the id out of its meter values", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: iso(-60) });
    const noTx = mv({ kw: 2 }) as { transactionId?: number };
    delete noTx.transactionId;
    await call(ws, "MeterValues", noTx);
    expect(ev.samples).toHaveLength(1);
  });

  it("stores a repeated sample once and a repeated start as the same session", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: iso(-60) });
    const same = mv({ ts: iso(-30) });
    await call(ws, "MeterValues", same);
    await call(ws, "MeterValues", same);
    expect(ev.samples).toHaveLength(1);
  });

  it("marks a session whose meter went backwards as suspect, and says so in the events", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    const start = await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 90_000, timestamp: iso(-600) });
    await call(ws, "StopTransaction", { transactionId: (start[2] as { transactionId: number }).transactionId, meterStop: 80_000, timestamp: iso() });
    expect(ev.sessions[0]!.summary).toMatchObject({ status: "suspect" });
    expect(ev.events.map((e) => e.kind)).toContain("session_suspect");
  });

  it("accepts a stop for a transaction it does not know, and records that", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    const r = await call(ws, "StopTransaction", { transactionId: 424242, meterStop: 1, timestamp: iso() });
    expect(r[0]).toBe(3);
    expect(ev.events.map((e) => e.kind)).toContain("stop_without_session");
  });

  it("uses the server's time when the charger's clock is nonsense, and says so", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: "2001-01-01T00:00:00Z" });
    expect(Math.abs(Date.parse(ev.sessions[0]!.startedAt) - Date.now())).toBeLessThan(5000);
    expect(ev.events.map((e) => e.kind)).toContain("bad_timestamp");
  });

  it("writes the charger's heartbeat to the status record at most every 30 seconds", async () => {
    const ws = await connect();
    answerServerCalls(ws);
    await call(ws, "BootNotification", { chargePointModel: "M", chargePointVendor: "V", firmwareVersion: "2.2.7" });
    for (let i = 0; i < 5; i++) await call(ws, "Heartbeat", {});
    expect(ev.heartbeats).toHaveLength(1);
    expect(ev.heartbeats[0]).toEqual({ equipmentId: EQ, firmware: "2.2.7" });
  });
});

describe("messages that are not right", () => {
  it("answers a message that does not match the schema with a CallError that names the fields, never the values", async () => {
    const ws = await connect();
    const r = await call(ws, "StartTransaction", { connectorId: 0, idTag: "SECRET-CARD-ID-THAT-IS-TOO-LONG", meterStart: 1, timestamp: iso() });
    expect(r[0]).toBe(4);
    expect(r[2]).toBe("FormationViolation");
    expect(JSON.stringify(r)).not.toContain("SECRET-CARD");
    expect(JSON.stringify(r[4])).toContain("connectorId");
    expect(ev.sessions).toHaveLength(0);
  });

  it("answers an action it does not support with NotImplemented", async () => {
    const ws = await connect();
    expect((await call(ws, "SetChargingProfile", {}))[2]).toBe("NotImplemented");
  });

  it("answers an internal failure with a plain InternalError (no detail), and the charger can try again", async () => {
    const ws = await connect();
    ev.failNext = 1;
    const r = await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: iso() });
    expect(r[2]).toBe("InternalError");
    expect(JSON.stringify(r)).not.toMatch(/database/i);
    const again = await call(ws, "StartTransaction", { connectorId: 1, idTag: "T", meterStart: 0, timestamp: iso() });
    expect(again[0]).toBe(3);
  });

  it("ignores frames that are not OCPP, and keeps going", async () => {
    const ws = await connect();
    ws.send("not json");
    ws.send(JSON.stringify({ a: 1 }));
    ws.send(JSON.stringify([9, "x"]));
    expect((await call(ws, "Heartbeat", {}))[0]).toBe(3);
  });

  it("closes a charger that sends far too fast", async () => {
    const ws = await connect();
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    for (let i = 0; i < 80; i++) ws.send(JSON.stringify([2, `f${i}`, "Heartbeat", {}]));
    expect(await closed).toBe(1008);
  });
});

describe("one connection per charger", () => {
  it("turns a second connection away while the first still answers, and records it", async () => {
    const first = await connect();
    answerServerCalls(first);
    await expect(connect().then((s) => new Promise((r) => s.once("close", r)))).resolves.toBeDefined();
    await wait(100);
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(ev.events.map((e) => e.kind)).toContain("duplicate_connection");
  });

  it("replaces a connection that no longer answers its pings", async () => {
    const first = await open(`/ocpp/${SECRET}/${NAME}`, { autoPong: false } as never);
    const firstClosed = new Promise<number>((r) => first.once("close", (code) => r(code)));
    const second = await connect();
    answerServerCalls(second);
    expect(await firstClosed).toBe(1012);
    expect((await call(second, "Heartbeat", {}))[0]).toBe(3);
  }, 20_000);
});

describe("commands from people", () => {
  const post = (path: string, body: object, token = "tok-owner") => app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}` }, payload: body });

  it("sends a remote start to the connected charger and returns its answer", async () => {
    const ws = await connect();
    const asked = answerServerCalls(ws);
    const r = await post(`/v1/ev/${EQ}/remote-start`, { connector_id: 1, id_tag: "APPUSER" });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("Accepted");
    expect(asked.at(-1)).toEqual({ action: "RemoteStartTransaction", payload: { connectorId: 1, idTag: "APPUSER" } });
    expect(ev.events.find((e) => e.kind === "command")!.detail).toMatchObject({ command: "remote-start", by: OWNER });
  });

  it("sends stop, reset, unlock and trigger the same way", async () => {
    const ws = await connect();
    const asked = answerServerCalls(ws);
    expect((await post(`/v1/ev/${EQ}/remote-stop`, { transaction_id: 1001 })).statusCode).toBe(200);
    expect((await post(`/v1/ev/${EQ}/reset`, { type: "Soft" })).statusCode).toBe(200);
    expect((await post(`/v1/ev/${EQ}/unlock`, {})).statusCode).toBe(200);
    expect((await post(`/v1/ev/${EQ}/trigger`, { message: "MeterValues" })).statusCode).toBe(200);
    expect(asked.map((a) => a.action).slice(-4)).toEqual(["RemoteStopTransaction", "Reset", "UnlockConnector", "TriggerMessage"]);
  });

  it("passes on a refusal from the charger", async () => {
    const ws = await connect();
    answerServerCalls(ws, () => ({ status: "Rejected" }));
    expect((await post(`/v1/ev/${EQ}/remote-start`, {})).json().status).toBe("Rejected");
  });

  it("says plainly when the charger is not connected", async () => {
    const r = await post(`/v1/ev/${EQ}/remote-start`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("offline");
  });

  it("refuses a person with no access exactly as for unknown equipment, and a request with no sign-in", async () => {
    await connect();
    const stranger = await post(`/v1/ev/${EQ}/remote-start`, {}, "tok-stranger");
    const unknown = await post(`/v1/ev/99999999-0000-4000-8000-000000000000/remote-start`, {});
    expect(stranger.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(stranger.json().error.message).toBe(unknown.json().error.message);
    expect((await app.inject({ method: "POST", url: `/v1/ev/${EQ}/remote-start`, payload: {} })).statusCode).toBe(401);
  });

  it("refuses values that are not allowed", async () => {
    await connect();
    expect((await post(`/v1/ev/${EQ}/reset`, { type: "Explode" })).statusCode).toBe(400);
    expect((await post(`/v1/ev/${EQ}/trigger`, { message: "Reboot" })).statusCode).toBe(400);
  });

  it("reports whether the charger is connected", async () => {
    const get = () => app.inject({ method: "GET", url: `/v1/ev/${EQ}/status`, headers: { authorization: "Bearer tok-owner" } });
    expect((await get()).json()).toMatchObject({ connected: false });
    await connect();
    expect((await get()).json()).toMatchObject({ connected: true, charge_point_id: NAME });
  });

  it("lets staff read what the charger sent, with card identifiers hidden, and nobody else", async () => {
    const ws = await connect();
    await call(ws, "Authorize", { idTag: "CARD-12345" });
    const frames = (token: string) => app.inject({ method: "GET", url: `/v1/ev/${EQ}/frames`, headers: { authorization: `Bearer ${token}` } });
    const r = await frames("tok-staff");
    expect(r.statusCode).toBe(200);
    const list = r.json().frames as { direction: string; frame: string }[];
    expect(list.some((f) => f.direction === "in" && f.frame.includes("Authorize"))).toBe(true);
    expect(list.some((f) => f.direction === "out")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("CARD-12345");
    expect(JSON.stringify(list)).toContain("[hidden]");
    expect((await frames("tok-owner")).statusCode).toBe(404);
    expect((await frames("tok-stranger")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/ev/${EQ}/frames` })).statusCode).toBe(401);
  });

  it("lets staff download a day of the long-term message log, and nobody else", async () => {
    await files.put(`ocpp/v1/${EQ}/2026/10/15/101500-abcd-1.ndjson.gz`, gzipSync(Buffer.from(JSON.stringify({ t: "2026-10-15T10:15:00.000Z", d: "in", f: "[2]" }) + "\n")));
    const get = (token: string, day = "2026-10-15") => app.inject({ method: "GET", url: `/v1/ev/${EQ}/frames/archive?day=${day}`, headers: { authorization: `Bearer ${token}` } });
    const r = await get("tok-staff");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/x-ndjson");
    expect(JSON.parse(r.body.trim())).toMatchObject({ d: "in", f: "[2]" });
    expect((await get("tok-staff", "2026-10-14")).body).toBe("");
    expect((await get("tok-staff", "2026-13-45")).statusCode).toBe(400);
    expect((await get("tok-staff", "yesterday")).statusCode).toBe(400);
    expect((await get("tok-owner")).statusCode).toBe(404);
    expect((await get("tok-stranger")).statusCode).toBe(404);
  });

  it("answers 504 when the charger does not answer", async () => {
    await connect(); // never answers server calls
    const r = await app.inject({ method: "POST", url: `/v1/ev/${EQ}/reset`, headers: { authorization: "Bearer tok-owner" }, payload: {} });
    expect(r.statusCode).toBe(504);
  }, 25_000);
});

describe("a secret that changes", () => {
  it("disconnects a charger whose secret was revoked, within seconds", async () => {
    const ws = await connect();
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ev.keys = [];
    bus.changed(EQ);
    expect(await closed).toBe(4001);
  });

  it("keeps a charger whose secret is still valid when something else about the equipment changed", async () => {
    const ws = await connect();
    bus.changed(EQ);
    await wait(300);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses a secret that was revoked", async () => {
    ev.keys = [];
    bus.changed(EQ);
    await expect(connect()).rejects.toMatchObject({ status: 404 });
  });

  it("does not accept a secret made for another charger name or another equipment", async () => {
    ev.keys = [...ev.keys, { equipmentId: OTHER, keyId: "kkkkkkkk-0000-4000-8000-000000000002", label: "OTHER_CP", ciphertext: vault.encrypt(Buffer.from("o".repeat(24)), { equipmentId: OTHER, kind: "charger" }), expiresAt: null }];
    bus.changed(OTHER);
    await expect(open(`/ocpp/${"o".repeat(24)}/${NAME}`)).rejects.toMatchObject({ status: 404 });
    expect((await open(`/ocpp/${"o".repeat(24)}/OTHER_CP`)).protocol).toBe("ocpp1.6");
  });
});
