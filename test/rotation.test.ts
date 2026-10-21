import { beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { open, seal } from "../src/core/seal.js";
import { KeyCache } from "../src/features/broker/key-cache.js";
import { dnTopic, upTopic } from "../src/features/broker/topics.js";
import { IngestService } from "../src/features/ingest/service.js";
import { RotationService } from "../src/features/keys/rotation.js";
import { AppError } from "../src/lib/errors.js";
import { KeyChangeBus } from "../src/lib/key-events.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";

// The whole key change with a simulated unit: the hub's rotation service, the real ingest service (which opens what the unit sends and seals what
// the hub sends) and a fake database that behaves like the SQL functions.

const EQ = "aaaaaaaa-0000-4000-8000-000000000001";
const CHARGER = "bbbbbbbb-0000-4000-8000-000000000002";
const SITE = "51000000-0000-4000-8000-000000000001";
const ADMIN = "a0000000-0000-4000-8000-000000000001";
const STRANGER = "e9000000-0000-4000-8000-000000000009";
const OLD_KEY = Buffer.alloc(32, 9);
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const silent = { info: () => undefined, warn: () => undefined };

let db: FakeDb;
let bus: KeyChangeBus;
let keys: KeyCache;
let nowMs: number;
let counter: number;
let published: { topic: string; payload: Buffer }[];
let failPublish: boolean;
let rejected: string[];
let svc: IngestService;
let rotation: RotationService;
let oldKeyId: string;

const sealUp = (name: "data" | "hb" | "evt", body: unknown, k: Buffer) => seal(body, { equipmentKey: k, equipmentId: EQ, direction: "up", topic: upTopic(EQ, name), counter: ++counter });
const commands = (k: Buffer) =>
  published.filter((p) => p.topic === dnTopic(EQ, "cmd")).map((p) => open<Record<string, unknown>>(p.payload, { equipmentKey: k, equipmentId: EQ, direction: "dn", topic: dnTopic(EQ, "cmd") }).body);
const activeKeys = async () => (await db.activeKeys(EQ)).length;

/** The unit says hello (with what its software can do) and checks in, as it does when it connects. */
async function connect(caps: string[], k: Buffer = OLD_KEY) {
  await svc.handleUp(EQ, "evt", sealUp("evt", { type: "hello", fw_version: "waytara-gw-test", map_ver: 0, caps }, k));
  await svc.handleUp(EQ, "hb", sealUp("hb", { boot: 1, uptime_s: 10, inverter_online: true }, k));
}

beforeEach(async () => {
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  db.addEquipment({ equipmentId: CHARGER, siteId: SITE, category: "ev_charger" });
  db.manage.add(`${ADMIN}|${EQ}`).add(`${ADMIN}|${CHARGER}`);
  oldKeyId = await db.createKey({ equipmentId: EQ, kind: "gateway", ciphertext: vault.encrypt(OLD_KEY, { equipmentId: EQ, kind: "gateway" }), fingerprint: "abcdef012345", actor: ADMIN });
  nowMs = 1_792_044_005_000;
  counter = 0;
  published = [];
  failPublish = false;
  rejected = [];
  bus = new KeyChangeBus();
  keys = new KeyCache(db, vault, 30_000, () => nowMs);
  bus.onChanged((id) => keys.invalidate(id));
  svc = new IngestService({
    keys,
    store: new FakeStore(),
    publish: async (_id, topic, payload) => {
      if (failPublish) throw new Error("down");
      published.push({ topic, payload });
    },
    log: silent,
    now: () => nowMs,
    onRejected: (_id, reason) => rejected.push(reason),
    onRotation: (id, type, rotationId, error) => void rotation.onUnitEvent(id, type, rotationId, error),
  });
  rotation = new RotationService(db, vault, { status: (id) => svc.unitStatus(id), command: (id, body) => svc.command(id, body) }, bus, { now: () => nowMs });
});

const actor = { id: ADMIN, ip: "203.0.113.7" };

describe("changing a unit's key without locking it out", () => {
  it("runs the whole way: new key sent sealed with the old one, staged, committed, the unit logs in with it, the old key is cut", async () => {
    await connect(["rotate_key"]);
    const started = await rotation.start(actor, EQ);
    expect(started.state).toBe("sent");
    expect(await activeKeys()).toBe(2); // both work while the key is delivered

    // 1. the hub sent "rotate_key", sealed with the OLD key; the new key is in it, and is not the old one
    const sent = commands(OLD_KEY).find((c) => c.type === "rotate_key")!;
    expect(sent.id).toBe(started.rotationId);
    const newKey = Buffer.from(String(sent.key), "base64url");
    expect(newKey.length).toBe(32);
    expect(newKey.equals(OLD_KEY)).toBe(false);
    expect(Number(sent.expires_at)).toBeGreaterThan(Number(sent.issued_at));
    // and the database holds it encrypted, never in the clear
    const stored = db.keys.find((k) => k.keyId === sent.key_id)!;
    expect(stored.ciphertext.includes(newKey)).toBe(false);
    expect(vault.decrypt(stored.ciphertext, { equipmentId: EQ, kind: "gateway" }).equals(newKey)).toBe(true);

    // 2. the unit keeps it aside and says so; the hub answers with "rotate_commit"
    await svc.handleUp(EQ, "evt", sealUp("evt", { type: "rotate_staged", id: started.rotationId }, OLD_KEY));
    await new Promise((r) => setTimeout(r, 0));
    expect((await rotation.status(actor, EQ)).state).toBe("staged");
    const commit = commands(OLD_KEY).find((c) => c.type === "rotate_commit");
    expect(commit).toMatchObject({ rotation: started.rotationId });

    // 3. the unit switches and logs in with the new key: the old key is cut at once
    await rotation.onLogin(EQ, String(sent.key_id), "203.0.113.7");
    expect(await activeKeys()).toBe(1);
    expect(db.keys.find((k) => k.keyId === oldKeyId)!.revokeReason).toBe("rotated");
    expect((await rotation.status(actor, EQ)).state).toBe("none");
    expect(db.events.some((e) => e.event === "rotated" && e.keyId === sent.key_id)).toBe(true);

    // 4. what the unit sends sealed with the new key is accepted; what is sealed with the old one no longer is
    published.length = 0;
    await svc.handleUp(EQ, "hb", sealUp("hb", { boot: 1, uptime_s: 20, inverter_online: true }, newKey));
    expect(rejected).toEqual([]);
    await svc.handleUp(EQ, "hb", sealUp("hb", { boot: 1, uptime_s: 30, inverter_online: true }, OLD_KEY));
    expect(rejected.length).toBe(1);
  });

  it("is not started for a unit that is not online, or whose software cannot do it", async () => {
    await expect(rotation.start(actor, EQ)).rejects.toMatchObject({ status: 409 }); // never connected
    await connect([]); // connected, but no "rotate_key" in what it can do
    const e = await rotation.start(actor, EQ).catch((x: AppError) => x);
    expect(e).toMatchObject({ status: 409 });
    expect((e as AppError).message).toMatch(/cannot change its key remotely/);
    expect(await activeKeys()).toBe(1);
    expect(db.rotations).toHaveLength(0);
  });

  it("says why it cannot start, and that it can when it can", async () => {
    expect((await rotation.status(actor, EQ)).reason).toMatch(/not online/);
    await connect(["rotate_key"]);
    expect(await rotation.status(actor, EQ)).toMatchObject({ canStart: true, reason: null, state: "none" });
    await rotation.start(actor, EQ);
    expect(await rotation.status(actor, EQ)).toMatchObject({ canStart: false, state: "sent", reason: expect.stringMatching(/already in progress/) });
  });

  it("allows one change at a time", async () => {
    await connect(["rotate_key"]);
    await rotation.start(actor, EQ);
    await expect(rotation.start(actor, EQ)).rejects.toMatchObject({ status: 409 });
    expect(await activeKeys()).toBe(2); // no third key
  });

  it("cuts the new key and keeps the old one when the unit says it could not take it", async () => {
    await connect(["rotate_key"]);
    const started = await rotation.start(actor, EQ);
    await svc.handleUp(EQ, "evt", sealUp("evt", { type: "rotate_failed", id: started.rotationId, error: "not enough space" }, OLD_KEY));
    await new Promise((r) => setTimeout(r, 0));
    expect(await activeKeys()).toBe(1);
    expect(db.keys.find((k) => k.keyId === oldKeyId)!.revokedAt).toBeNull();
    expect(db.rotations[0]!.state).toBe("cancelled");
    // and a new change can be tried again
    await expect(rotation.start(actor, EQ)).resolves.toMatchObject({ state: "sent" });
  });

  it("cancels at once, leaving things as they were, when the command cannot be sent", async () => {
    await connect(["rotate_key"]);
    failPublish = true;
    await expect(rotation.start(actor, EQ)).rejects.toMatchObject({ status: 409 });
    expect(await activeKeys()).toBe(1);
    expect(db.keys.find((k) => k.keyId === oldKeyId)!.revokedAt).toBeNull();
    expect(db.rotations[0]!.state).toBe("cancelled");
  });

  it("ignores a late or repeated 'staged' answer, and a login with the old key", async () => {
    await connect(["rotate_key"]);
    const started = await rotation.start(actor, EQ);
    await svc.handleUp(EQ, "evt", sealUp("evt", { type: "rotate_staged", id: started.rotationId }, OLD_KEY));
    await svc.handleUp(EQ, "evt", sealUp("evt", { type: "rotate_staged", id: started.rotationId }, OLD_KEY));
    await new Promise((r) => setTimeout(r, 0));
    expect(commands(OLD_KEY).filter((c) => c.type === "rotate_commit")).toHaveLength(1);
    await rotation.onLogin(EQ, oldKeyId, null); // the unit logged in with the old key: nothing is finished
    expect(await activeKeys()).toBe(2);
    expect(db.rotations[0]!.state).toBe("staged");
  });

  it("tells a person who may not manage the unit it does not exist, and refuses a charger", async () => {
    await connect(["rotate_key"]);
    await expect(rotation.start({ id: STRANGER, ip: null }, EQ)).rejects.toMatchObject({ status: 404 });
    await expect(rotation.status({ id: STRANGER, ip: null }, EQ)).rejects.toMatchObject({ status: 404 });
    await expect(rotation.start(actor, CHARGER)).rejects.toMatchObject({ status: 400 });
    expect(db.rotations).toHaveLength(0);
  });
});
