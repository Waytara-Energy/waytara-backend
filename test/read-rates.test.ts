import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const STAFF = "e1000000-0000-4000-8000-000000000001";
const CUSTOMER = "c1000000-0000-4000-8000-000000000001";
const vault = new KeyVault({ current: Buffer.alloc(32, 5) });
const users: Record<string, AuthUser> = { "tok-staff": { id: STAFF, role: "authenticated" }, "tok-customer": { id: CUSTOMER, role: "authenticated" } };
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};

let app: FastifyInstance;
let db: FakeDb;
const url = `/v1/equipment/${EQ}/read-rates`;
const get = (token: string | null = "tok-staff") => app.inject({ method: "GET", url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
const put = (body: unknown, token = "tok-staff") => app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${token}` }, payload: body as object });

beforeEach(async () => {
  db = new FakeDb();
  db.manage.add(`${STAFF}|${EQ}`);
  db.cadences.set(EQ, [
    { key: "pv1_power_w", label: "PV1 power", unit: "W", category: "solar", registers: [672], seconds: 30, map_s: 30, custom: false },
    { key: "battery_temp_c", label: "Battery temperature", unit: "°C", category: "battery", registers: [182], seconds: 60, map_s: 60, custom: false },
  ]);
  app = await testApp({}, { db, verify, vault, store: new FakeStore() });
});
afterEach(async () => {
  await app?.close();
});

describe("the read rate of each value of a unit", () => {
  it("lists the values with the rate in force, the map's rate and what may be chosen", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.allowed).toEqual([10, 15, 30, 60, 120, 300, 600, 900]);
    expect(body.default).toBe(30);
    expect(body.metrics.map((m: { key: string }) => m.key)).toEqual(["pv1_power_w", "battery_temp_c"]);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("changes some values, and puts the map's rate back with null", async () => {
    const r = await put({ changes: [{ key: "pv1_power_w", seconds: 10 }, { key: "battery_temp_c", seconds: 300 }] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ changed: 2 });
    expect((await get()).json().metrics.map((m: { seconds: number; custom: boolean }) => [m.seconds, m.custom])).toEqual([[10, true], [300, true]]);
    expect((await put({ changes: [{ key: "pv1_power_w", seconds: null }] })).json()).toEqual({ changed: 1 });
    expect((await get()).json().metrics[0]).toMatchObject({ seconds: 30, custom: false });
  });

  it("counts only what really changed", async () => {
    expect((await put({ changes: [{ key: "pv1_power_w", seconds: 30 }] })).json()).toEqual({ changed: 0 });
  });

  it("is a plain 404 for a person who does not manage the unit, and nothing changes", async () => {
    expect((await get("tok-customer")).statusCode).toBe(404);
    expect((await put({ changes: [{ key: "pv1_power_w", seconds: 10 }] }, "tok-customer")).statusCode).toBe(404);
    expect((await get()).json().metrics[0].seconds).toBe(30);
  });

  it("refuses a rate that is not in the list, an unknown value, and a body of the wrong shape", async () => {
    for (const bad of [{ changes: [{ key: "pv1_power_w", seconds: 7 }] }, { changes: [{ key: "nope", seconds: 60 }] }, { changes: [] }, { changes: [{ key: "pv1_power_w", seconds: "60" }] }, {}]) {
      expect((await put(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await get()).json().metrics[0].seconds).toBe(30);
  });

  it("needs a sign-in", async () => {
    expect((await get(null)).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url, payload: { changes: [{ key: "pv1_power_w", seconds: 10 }] } })).statusCode).toBe(401);
  });
});
