import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const STAFF = "e1000000-0000-4000-8000-000000000001";
const OTHER = "c1000000-0000-4000-8000-000000000009";
const vault = new KeyVault({ current: Buffer.alloc(32, 5) });
const users: Record<string, AuthUser> = { "tok-staff": { id: STAFF, role: "authenticated" }, "tok-other": { id: OTHER, role: "authenticated" } };
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};

let app: FastifyInstance;
let db: FakeDb;
const wake = (id = EQ, token: string | null = "tok-staff") => app.inject({ method: "POST", url: `/v1/equipment/${id}/live-wake`, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

beforeEach(async () => {
  db = new FakeDb();
  db.cadence.set(`${STAFF}|${EQ}`, "staff");
  app = await testApp({}, { db, verify, vault, store: new FakeStore() });
});
afterEach(async () => {
  await app?.close();
});

describe("POST /v1/equipment/:id/live-wake (T13)", () => {
  it("is answered at once for someone who may read the unit", async () => {
    const r = await wake();
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: true });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("is a plain 404 for someone without access, and for a unit that does not exist", async () => {
    expect((await wake(EQ, "tok-other")).statusCode).toBe(404);
    expect((await wake("aaaaaaaa-0000-4000-8000-0000000000ff")).statusCode).toBe(404);
  });

  it("needs a signed-in person and a valid unit id", async () => {
    expect((await wake(EQ, null)).statusCode).toBe(401);
    expect((await wake("not-an-id")).statusCode).toBe(400);
  });
});
