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
const url = `/v1/equipment/${EQ}/push-interval`;
const get = (token: string | null = "tok-staff") => app.inject({ method: "GET", url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
const put = (body: unknown, token = "tok-staff") => app.inject({ method: "PUT", url, headers: { authorization: `Bearer ${token}` }, payload: body as object });

beforeEach(async () => {
  db = new FakeDb();
  db.manage.add(`${STAFF}|${EQ}`);
  app = await testApp({}, { db, verify, vault, store: new FakeStore() });
});
afterEach(async () => {
  await app?.close();
});

describe("the push interval of a unit", () => {
  it("starts at 15 minutes and lists what may be chosen", async () => {
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ seconds: 900, allowed: [60, 120, 300, 600, 900, 1800, 3600], default: 900 });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("is changed by someone who manages the unit, and the new value is kept", async () => {
    const r = await put({ seconds: 300 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ seconds: 300, previous: 900 });
    expect((await get()).json().seconds).toBe(300);
    expect((await put({ seconds: 3600 })).json()).toMatchObject({ seconds: 3600, previous: 300 });
  });

  it("is a plain 404 for a person who does not manage the unit, for both reading and changing", async () => {
    expect((await get("tok-customer")).statusCode).toBe(404);
    const r = await put({ seconds: 60 }, "tok-customer");
    expect(r.statusCode).toBe(404);
    expect((await get()).json().seconds).toBe(900); // nothing changed
  });

  it("refuses a value that is not in the list, and a body that is not the right shape, naming the problem not the value", async () => {
    for (const bad of [{ seconds: 45 }, { seconds: 100_000 }, { seconds: 300.5 }, { seconds: "300" }, {}, { secs: 300 }]) {
      const r = await put(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await get()).json().seconds).toBe(900);
  });

  it("needs a sign-in", async () => {
    expect((await get(null)).statusCode).toBe(401);
    expect((await get("tok-made-up")).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url, payload: { seconds: 300 } })).statusCode).toBe(401);
  });

  it("says the service is busy, not what went wrong, when the database is down", async () => {
    const { DbError } = await import("../src/db/gateway-db.js");
    db.down = new DbError("unavailable", "connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
    const r = await put({ seconds: 300 });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain("hunter2");
  });
});
