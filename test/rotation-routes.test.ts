import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const CHARGER = "d4c30eb8-fba4-4487-aa7a-3c1b089e36e3";
const SITE = "51000000-0000-4000-8000-000000000001";
const STAFF = "e1000000-0000-4000-8000-000000000001";
const CUSTOMER = "c1000000-0000-4000-8000-000000000001";
const vault = new KeyVault({ current: Buffer.alloc(32, 6) });
const users: Record<string, AuthUser> = { "tok-staff": { id: STAFF, role: "authenticated" }, "tok-customer": { id: CUSTOMER, role: "authenticated" } };
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};

let app: FastifyInstance;
const url = (id = EQ) => `/v1/equipment/${id}/rotation`;
const call = (method: "GET" | "POST", token: string | null = "tok-staff", id = EQ) => app.inject({ method, url: url(id), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

beforeEach(async () => {
  const db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  db.addEquipment({ equipmentId: CHARGER, siteId: SITE, category: "ev_charger" });
  db.manage.add(`${STAFF}|${EQ}`).add(`${STAFF}|${CHARGER}`);
  app = await testApp({}, { db, verify, vault, store: new FakeStore() });
});
afterEach(async () => {
  await app?.close();
});

describe("the key change routes", () => {
  it("say a unit that is not connected cannot have its key changed, in plain words", async () => {
    const r = await call("GET");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "none", can_start: false });
    expect(r.json().reason).toMatch(/not online/);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("refuse to start one for a unit that is not connected, and for a charger", async () => {
    const off = await call("POST");
    expect(off.statusCode).toBe(409);
    expect(off.json().error.message).toMatch(/not online/);
    expect((await call("POST", "tok-staff", CHARGER)).statusCode).toBe(400);
  });

  it("answer a person who may not manage the unit, or nobody, as for something that does not exist", async () => {
    expect((await call("GET", "tok-customer")).statusCode).toBe(404);
    expect((await call("POST", "tok-customer")).statusCode).toBe(404);
    expect((await call("GET", null)).statusCode).toBe(401);
    expect((await call("GET", "tok-made-up")).statusCode).toBe(401);
  });
});
