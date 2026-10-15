import { createECDH, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eciesDecrypt } from "../src/core/ecies.js";
import { KeyVault } from "../src/core/key-vault.js";
import { DbError } from "../src/db/gateway-db.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { FakeDb } from "./fakes.js";
import { appWithLogCapture, testApp } from "./helpers.js";

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const STAFF = "e1000000-0000-4000-8000-0000000000e1"; // assigned to the site
const OTHER_STAFF = "e2000000-0000-4000-8000-0000000000e2"; // assigned to nothing
const OWNER = "c1000000-0000-4000-8000-000000000001"; // the customer who owns the site
const STRANGER = "c2000000-0000-4000-8000-000000000002";
const SITE = "51000000-0000-4000-8000-000000000001";
const INVERTER = "91000000-0000-4000-8000-000000000001";
const CHARGER = "92000000-0000-4000-8000-000000000002";

const users: Record<string, AuthUser> = {
  "tok-admin": { id: ADMIN, role: "authenticated" },
  "tok-staff": { id: STAFF, role: "authenticated" },
  "tok-other": { id: OTHER_STAFF, role: "authenticated" },
  "tok-owner": { id: OWNER, role: "authenticated" },
  "tok-stranger": { id: STRANGER, role: "authenticated" },
};
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
let db: FakeDb;
let app: FastifyInstance;

function seed(): FakeDb {
  const d = new FakeDb();
  d.addEquipment({ equipmentId: INVERTER, siteId: SITE, label: "Office inverter" });
  d.addEquipment({ equipmentId: CHARGER, siteId: SITE, label: "Office charger", category: "ev_charger", technicalSpecs: null });
  for (const who of [ADMIN, STAFF]) d.manage.add(`${who}|${INVERTER}`).add(`${who}|${CHARGER}`);
  for (const who of [ADMIN, STAFF, OWNER]) d.access.add(`${who}|${SITE}`);
  return d;
}

beforeEach(async () => {
  db = seed();
  app = await testApp({}, { db, verify, vault });
});
afterEach(async () => {
  await app?.close();
});

const post = (url: string, token: string | null, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: token ? bearer(token) : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe("signing in", () => {
  it("refuses a call with no token, a bad token, or a malformed header", async () => {
    expect((await post(`/v1/equipment/${INVERTER}/keys`, null, { kind: "gateway" })).statusCode).toBe(401);
    expect((await post(`/v1/equipment/${INVERTER}/keys`, "nonsense", { kind: "gateway" })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: `/v1/equipment/${INVERTER}/keys`, headers: { authorization: "Basic abc" }, payload: { kind: "gateway" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("whoami says who is signed in", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/whoami", headers: bearer("tok-staff") });
    expect(res.json()).toEqual({ user_id: STAFF, email: null, role: "authenticated" });
  });

  it("answers 503, not 401, when the signing keys cannot be fetched", async () => {
    await app.close();
    app = await testApp({}, { db, vault, verify: async () => { throw new Error("jwks fetch failed: ECONNREFUSED"); } });
    const res = await app.inject({ method: "GET", url: "/v1/whoami", headers: bearer("tok-staff") });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("ECONNREFUSED");
  });
});

describe("creating a key", () => {
  it("gives a gateway key once, stores only the encrypted form, and never caches the answer", async () => {
    const res = await post(`/v1/equipment/${INVERTER}/keys`, "tok-staff", { kind: "gateway", label: "board A" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.kind).toBe("gateway");
    expect(body.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.keys(body).sort()).toEqual(["created_at", "equipment_id", "fingerprint", "key_id", "kind", "secret"]);

    const stored = db.keys.find((k) => k.keyId === body.key_id)!;
    expect(stored.ciphertext.toString("latin1")).not.toContain(body.secret);
    const plain = vault.decrypt(stored.ciphertext, { equipmentId: INVERTER, kind: "gateway" });
    expect(plain.toString("base64url")).toBe(body.secret);
    expect(KeyVault.fingerprint(plain)).toBe(body.fingerprint);
    expect(db.events.filter((e) => e.event === "created")).toHaveLength(1);
  });

  it("gives a charger key as 24 letters and digits", async () => {
    const res = await post(`/v1/equipment/${CHARGER}/keys`, "tok-admin", { kind: "charger" });
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).toMatch(/^[a-z0-9]{24}$/);
    const stored = db.keys[0]!;
    expect(vault.decrypt(stored.ciphertext, { equipmentId: CHARGER, kind: "charger" }).toString()).toBe(res.json().secret);
  });

  it("makes a different key every time", async () => {
    const a = (await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway" })).json().secret;
    const b = (await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway" })).json().secret;
    expect(a).not.toBe(b);
  });

  it("refuses the wrong kind for the equipment", async () => {
    expect((await post(`/v1/equipment/${CHARGER}/keys`, "tok-admin", { kind: "gateway" })).statusCode).toBe(400);
    expect((await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "charger" })).statusCode).toBe(400);
    expect(db.keys).toHaveLength(0);
  });

  it("says 'not found' to everyone who may not manage keys, exactly as for something that does not exist", async () => {
    const unassigned = await post(`/v1/equipment/${INVERTER}/keys`, "tok-other", { kind: "gateway" });
    const customer = await post(`/v1/equipment/${INVERTER}/keys`, "tok-owner", { kind: "gateway" });
    const missing = await post(`/v1/equipment/${randomUUID()}/keys`, "tok-admin", { kind: "gateway" });
    for (const r of [unassigned, customer, missing]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("not_found");
    }
    expect(db.keys).toHaveLength(0);
  });

  it("checks the request shape without echoing what was sent", async () => {
    const bad = await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "toaster", label: "SECRET-LABEL-VALUE" });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("SECRET-LABEL-VALUE");
    expect((await post(`/v1/equipment/not-a-uuid/keys`, "tok-admin", { kind: "gateway" })).statusCode).toBe(400);
    expect((await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway", label: "x".repeat(200) })).statusCode).toBe(400);
  });

  it("hides a database outage behind a plain 503", async () => {
    db.down = new DbError("unavailable", "connect ECONNREFUSED 10.1.2.3:5432 password=hunter2");
    const res = await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("hunter2");
    expect(res.json().error.code).toBe("unavailable");
  });

  it("limits how fast keys can be made", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway" })).statusCode;
    expect(last).toBe(429);
  });
});

describe("rotating and revoking", () => {
  async function make() {
    return (await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway" })).json();
  }

  it("rotates with no grace: the old key stops at once and the new one is returned once", async () => {
    const first = await make();
    const res = await post(`/v1/keys/${first.key_id}/rotate`, "tok-staff", {});
    expect(res.statusCode).toBe(201);
    expect(res.json().secret).not.toBe(first.secret);
    expect(res.json().replaces).toBe(first.key_id);
    expect((await db.activeKeys(INVERTER)).map((k) => k.keyId)).toEqual([res.json().key_id]);
  });

  it("rotates with a grace period: both keys work for a while", async () => {
    const first = await make();
    await post(`/v1/keys/${first.key_id}/rotate`, "tok-staff", { grace_seconds: 120 });
    expect(await db.activeKeys(INVERTER)).toHaveLength(2);
  });

  it("will not rotate a revoked key, a missing key, or one the caller may not manage", async () => {
    const first = await make();
    expect((await post(`/v1/keys/${first.key_id}/rotate`, "tok-other", {})).statusCode).toBe(404);
    expect((await post(`/v1/keys/${first.key_id}/rotate`, "tok-owner", {})).statusCode).toBe(404);
    expect((await post(`/v1/keys/${randomUUID()}/rotate`, "tok-admin", {})).statusCode).toBe(404);
    await app.inject({ method: "DELETE", url: `/v1/keys/${first.key_id}`, headers: bearer("tok-admin") });
    expect((await post(`/v1/keys/${first.key_id}/rotate`, "tok-admin", {})).statusCode).toBe(404);
  });

  it("rejects an absurd grace period", async () => {
    const first = await make();
    expect((await post(`/v1/keys/${first.key_id}/rotate`, "tok-admin", { grace_seconds: 999_999 })).statusCode).toBe(400);
    expect((await post(`/v1/keys/${first.key_id}/rotate`, "tok-admin", { grace_seconds: -1 })).statusCode).toBe(400);
  });

  it("revokes once, and says so when there was nothing left to revoke", async () => {
    const first = await make();
    const a = await app.inject({ method: "DELETE", url: `/v1/keys/${first.key_id}`, headers: bearer("tok-staff"), payload: { reason: "board lost" } });
    expect(a.json()).toEqual({ revoked: true });
    const b = await app.inject({ method: "DELETE", url: `/v1/keys/${first.key_id}`, headers: bearer("tok-staff") });
    expect(b.json()).toEqual({ revoked: false });
    expect(await db.activeKeys(INVERTER)).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: `/v1/keys/${first.key_id}`, headers: bearer("tok-other") })).statusCode).toBe(404);
  });
});

describe("claim tickets", () => {
  it("lets the owner, assigned staff and an admin get a ticket", async () => {
    for (const who of ["tok-owner", "tok-staff", "tok-admin"]) {
      const res = await post(`/v1/equipment/${INVERTER}/claim-tickets`, who, { hardware_id: "A1B2C3D4E5F6" });
      expect(res.statusCode).toBe(201);
      expect(res.json().ticket).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });

  it("refuses a stranger and unassigned staff with 'not found'", async () => {
    for (const who of ["tok-stranger", "tok-other"]) {
      expect((await post(`/v1/equipment/${INVERTER}/claim-tickets`, who, { hardware_id: "A1B2C3D4E5F6" })).statusCode).toBe(404);
    }
  });

  it("refuses a charger, an unknown equipment and a malformed hardware id", async () => {
    expect((await post(`/v1/equipment/${CHARGER}/claim-tickets`, "tok-admin", { hardware_id: "A1B2C3D4E5F6" })).statusCode).toBe(400);
    expect((await post(`/v1/equipment/${randomUUID()}/claim-tickets`, "tok-admin", { hardware_id: "A1B2C3D4E5F6" })).statusCode).toBe(404);
    expect((await post(`/v1/equipment/${INVERTER}/claim-tickets`, "tok-admin", { hardware_id: "bad id!" })).statusCode).toBe(400);
    expect((await post(`/v1/equipment/${INVERTER}/claim-tickets`, "tok-admin", {})).statusCode).toBe(400);
  });
});

describe("a board claims its key", () => {
  const board = createECDH("prime256v1");
  board.generateKeys();
  const boardPublic = board.getPublicKey().toString("base64url");
  const HW = "A1B2C3D4E5F6";

  const ticket = async (who = "tok-owner") => (await post(`/v1/equipment/${INVERTER}/claim-tickets`, who, { hardware_id: HW })).json().ticket as string;
  const claim = (t: string, over: Record<string, unknown> = {}) => post("/v1/claim", null, { ticket: t, hardware_id: HW, board_public_key: boardPublic, ...over });

  it("hands over the key inside a box only the board can open, and stores the same key encrypted", async () => {
    const res = await claim(await ticket());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.equipment_id).toBe(INVERTER);
    expect(Object.keys(body).sort()).toEqual(["alg", "ciphertext", "equipment_id", "key_id", "nonce", "server_public_key"]);

    const key = eciesDecrypt(board.getPrivateKey(), {
      ephemeralPublicKey: Buffer.from(body.server_public_key, "base64url"),
      nonce: Buffer.from(body.nonce, "base64url"),
      ciphertext: Buffer.from(body.ciphertext, "base64url"),
    }, `${INVERTER}|${HW}`);
    expect(key.length).toBe(32);
    const stored = db.keys.find((k) => k.keyId === body.key_id)!;
    expect(vault.decrypt(stored.ciphertext, { equipmentId: INVERTER, kind: "gateway" }).equals(key)).toBe(true);
    expect(res.body).not.toContain(key.toString("base64url"));
    expect(db.devices.get(INVERTER)).toBe(HW);
  });

  it("works only once per ticket", async () => {
    const t = await ticket();
    expect((await claim(t)).statusCode).toBe(200);
    const again = await claim(t);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("not_found");
  });

  it("claiming again replaces the board's key", async () => {
    const first = (await claim(await ticket())).json();
    const second = (await claim(await ticket("tok-staff"))).json();
    expect(second.key_id).not.toBe(first.key_id);
    expect((await db.activeKeys(INVERTER)).map((k) => k.keyId)).toEqual([second.key_id]);
  });

  it("looks the same whether the ticket is wrong, used, expired or for another board", async () => {
    const t = await ticket();
    const results = [await claim(randomUUID()), await claim(t, { hardware_id: "FFEEDDCCBBAA" })];
    db.now = () => Date.now() + 16 * 60_000;
    results.push(await claim(t));
    for (const r of results) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toMatchObject({ code: "not_found", message: "Invalid or expired ticket" });
    }
    expect(db.keys).toHaveLength(0);
  });

  it("refuses a board key that is not a real point, without using up the ticket", async () => {
    const t = await ticket();
    const bad = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
    expect((await claim(t, { board_public_key: bad })).statusCode).toBe(400);
    expect((await claim(t, { board_public_key: "tooshort" })).statusCode).toBe(400);
    expect((await claim(t)).statusCode).toBe(200);
  });

  it("refuses a board that already belongs to other equipment", async () => {
    db.devices.set(randomUUID(), HW);
    expect((await claim(await ticket())).statusCode).toBe(409);
  });

  it("limits attempts per address, so a ticket cannot be guessed", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await claim(randomUUID())).statusCode;
    expect(last).toBe(429);
  });

  it("needs no sign-in, but a malformed request is a plain 400", async () => {
    expect((await post("/v1/claim", null, { ticket: "nope" })).statusCode).toBe(400);
    expect((await post("/v1/claim", null)).statusCode).toBe(400);
  });
});

describe("logs", () => {
  it("never contain a key, a ticket or a token", async () => {
    await app.close();
    const cap = await appWithLogCapture({}, { db, verify, vault });
    app = cap.app;
    const created = (await post(`/v1/equipment/${INVERTER}/keys`, "tok-admin", { kind: "gateway" })).json();
    const t = (await post(`/v1/equipment/${INVERTER}/claim-tickets`, "tok-owner", { hardware_id: "A1B2C3D4E5F6" })).json().ticket;
    await post("/v1/claim", null, { ticket: t, hardware_id: "A1B2C3D4E5F6", board_public_key: "x".repeat(87) });
    const text = cap.lines.join("\n");
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [created.secret, t, "tok-admin", "tok-owner"]) expect(text).not.toContain(secret);
  });
});

describe("readiness", () => {
  it("reports the database as part of /readyz", async () => {
    expect((await app.inject({ method: "GET", url: "/readyz" })).json().checks).toEqual({ database: "ok" });
    db.down = new DbError("unavailable", "x");
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: "fail" });
  });

  it("leaves the key endpoints out when the database settings are missing", async () => {
    await app.close();
    app = await testApp();
    expect((await app.inject({ method: "GET", url: "/v1/whoami" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
