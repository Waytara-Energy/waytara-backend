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

const GW = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const CHARGER = "ca7809ea-cfc9-4dd3-aeba-cd245a84e7ca";
const SECRET = "k3x9q2m7p4w8z1n5v6c0b2d4";
const NAME = "WT_PZ_7k_1";
const OWNER = "c1000000-0000-4000-8000-000000000001";
const STRANGER = "c2000000-0000-4000-8000-000000000002";
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const users: Record<string, AuthUser> = { "tok-owner": { id: OWNER, role: "authenticated" }, "tok-stranger": { id: STRANGER, role: "authenticated" } };
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
  ev.keys = [{ equipmentId: CHARGER, keyId: "kkkkkkkk-0000-4000-8000-000000000001", label: NAME, ciphertext: vault.encrypt(Buffer.from(SECRET, "utf8"), { equipmentId: CHARGER, kind: "charger" }), expiresAt: null }];
  ev.access_.set(`${OWNER}|${GW}`, "owner");
  app = await testApp({}, { db: new FakeDb(), verify, vault, store: new FakeStore(), evStore: ev, bus: new KeyChangeBus(), objectStore: new MemoryObjectStore() } as never);
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await app.close();
});

const url = `/v1/ev/gateways/${GW}/chargers`;
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const list = (token = "tok-owner") => app.inject({ method: "GET", url, headers: as(token) });
const add = (body: object, token = "tok-owner") => app.inject({ method: "POST", url, headers: as(token), payload: body });
const remove = (cp: string, token = "tok-owner") => app.inject({ method: "DELETE", url: `${url}/${cp}`, headers: as(token) });

describe("the chargers of a monitoring unit", () => {
  it("is closed to someone who may not manage the unit (and to nobody signed in)", async () => {
    expect((await list("tok-stranger")).statusCode).toBe(404);
    expect((await add({ charge_point_id: "CP1" }, "tok-stranger")).statusCode).toBe(404);
    expect((await remove("CP1", "tok-stranger")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect(ev.bindings.size).toBe(0);
  });

  it("lets the owner add a charger, see it in the list, and remove it", async () => {
    expect(((await list()).json() as { chargers: unknown[] }).chargers).toEqual([]);

    const created = await add({ charge_point_id: "WT-05D0", label: "Plugzmart 7.4kW" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ charge_point_id: "WT-05D0", label: "Plugzmart 7.4kW", equipment_id: expect.any(String) });

    const after = (await list()).json() as { chargers: { charge_point_id: string; label: string; connected: boolean; last_message_at: string | null }[] };
    expect(after.chargers).toHaveLength(1);
    expect(after.chargers[0]).toMatchObject({ charge_point_id: "WT-05D0", label: "Plugzmart 7.4kW", connected: false, last_message_at: null });

    expect((await remove("WT-05D0")).json()).toEqual({ removed: true });
    expect((await remove("WT-05D0")).json()).toEqual({ removed: false });
    expect(((await list()).json() as { chargers: unknown[] }).chargers).toEqual([]);
  });

  it("uses a default name when none is given", async () => {
    const r = await add({ charge_point_id: "WT-05D0" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ label: "EV charger" });
  });

  it("refuses the same charger name twice with a plain reason", async () => {
    expect((await add({ charge_point_id: "CP1" })).statusCode).toBe(201);
    const again = await add({ charge_point_id: "CP1" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "already_added" } });
  });

  it("refuses a charger name that cannot be part of an address", async () => {
    expect((await add({ charge_point_id: "bad name" })).statusCode).toBe(400);
    expect((await add({ charge_point_id: "" })).statusCode).toBe(400);
    expect((await add({})).statusCode).toBe(400);
    expect((await remove("bad%20name")).statusCode).toBe(400);
    expect(ev.bindings.size).toBe(0);
  });

  it("says connected once the charger is connected to the hub", async () => {
    ev.bindings.set(`${GW}|WT-05D0`, { equipmentId: CHARGER, chargePointId: "WT-05D0", label: "Plugzmart" });
    expect(((await list()).json() as { chargers: { connected: boolean }[] }).chargers[0]!.connected).toBe(false);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/${SECRET}/${NAME}`, "ocpp1.6");
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const end = Date.now() + 3000;
    let connected = false;
    while (Date.now() < end && !connected) {
      connected = ((await list()).json() as { chargers: { connected: boolean }[] }).chargers[0]!.connected;
      if (!connected) await new Promise((r) => setTimeout(r, 20));
    }
    expect(connected).toBe(true);
    const row = ((await list()).json() as { chargers: { last_message_at: string | null }[] }).chargers[0]!;
    expect(row.last_message_at).toEqual(expect.any(String));
  });
});
