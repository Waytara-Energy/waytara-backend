import { generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGrant } from "../src/core/ble-grant.js";
import { KeyVault } from "../src/core/key-vault.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const STAFF = "e1000000-0000-4000-8000-000000000001";
const CUSTOMER = "c1000000-0000-4000-8000-000000000001";
const OTHER = "c1000000-0000-4000-8000-000000000009";
const key = Buffer.alloc(32, 7);
const vault = new KeyVault({ current: Buffer.alloc(32, 5) });
const users: Record<string, AuthUser> = { "tok-staff": { id: STAFF, role: "authenticated" }, "tok-customer": { id: CUSTOMER, role: "authenticated" }, "tok-other": { id: OTHER, role: "authenticated" } };
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const raw = (): Buffer => {
  const jwk = ec.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
};
const pub = raw();

let app: FastifyInstance;
let db: FakeDb;
const ask = (token: string | null = "tok-staff", payload: unknown = { pub: pub.toString("base64url") }, id = EQ) =>
  app.inject({ method: "POST", url: `/v1/equipment/${id}/ble-grant`, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), payload: payload as object });

beforeEach(async () => {
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: "51000000-0000-4000-8000-000000000001" });
  await db.createKey({ equipmentId: EQ, kind: "gateway", ciphertext: vault.encrypt(key, { equipmentId: EQ, kind: "gateway" }), fingerprint: "abcdef012345", actor: "a" });
  db.ble.set(`${STAFF}|${EQ}`, "service");
  db.ble.set(`${CUSTOMER}|${EQ}`, "network");
  app = await testApp({}, { db, verify, vault, store: new FakeStore() });
});
afterEach(async () => {
  await app?.close();
});

describe("POST /v1/equipment/:id/ble-grant (T15)", () => {
  it("gives staff a service grant that the unit can open with its key, for the connection it asked for", async () => {
    const r = await ask();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ level: 3, level_name: "service", expires_in: 120 });
    expect(r.headers["cache-control"]).toBe("no-store");
    const opened = openGrant(Buffer.from(b.grant, "base64url"), { equipmentKey: key, equipmentId: EQ, devicePublicKey: pub, nowS: Math.floor(Date.now() / 1000) });
    expect(opened).toMatchObject({ level: 3, userId: STAFF });
  });

  it("gives the customer who owns the site the network level only", async () => {
    const r = await ask("tok-customer");
    expect(r.json()).toMatchObject({ level: 2, level_name: "network" });
  });

  it("is a plain 404 for someone without access, and the request is not logged", async () => {
    expect((await ask("tok-other")).statusCode).toBe(404);
    expect((await ask(null)).statusCode).toBe(401);
    expect(db.bleRequests.map((x) => x.actor)).toEqual([]);
  });

  it("logs each granted request with who asked", async () => {
    await ask();
    await ask("tok-customer");
    expect(db.bleRequests).toEqual([
      { actor: STAFF, equipmentId: EQ },
      { actor: CUSTOMER, equipmentId: EQ },
    ]);
  });

  it("refuses a body that is not a unit's public key", async () => {
    for (const bad of [{}, { pub: "abc" }, { pub: Buffer.alloc(65, 1).toString("base64url") }, { pub: pub.toString("base64url") + "A" }]) {
      expect((await ask("tok-staff", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await ask("tok-staff", { pub: pub.toString("base64url") }, "not-an-id")).statusCode).toBe(400);
  });

  it("asks the person to wait while the unit is changing its key, and explains a unit that has no key", async () => {
    const empty = new FakeDb();
    empty.addEquipment({ equipmentId: EQ, siteId: "51000000-0000-4000-8000-000000000001" });
    empty.ble.set(`${STAFF}|${EQ}`, "service");
    await app.close();
    app = await testApp({}, { db: empty, verify, vault, store: new FakeStore() });
    const r = await ask();
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message ?? JSON.stringify(r.json())).toMatch(/not been set up/);
  });
});
