import { beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { open, seal } from "../src/core/seal.js";
import { KeyCache } from "../src/features/broker/key-cache.js";
import { dnTopic, upTopic } from "../src/features/broker/topics.js";
import { IngestService } from "../src/features/ingest/service.js";
import type { LiveStore } from "../src/features/ingest/live.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";

const EQ = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE = "51000000-0000-4000-8000-000000000001";
const S = 1_792_044_000;
const key = Buffer.alloc(32, 9);
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const silent = { info: () => undefined, warn: () => undefined };

class LiveFakeStore extends FakeStore implements LiveStore {
  watching = false;
  ticks: { t: number; v: Record<string, number> }[] = [];
  checks = 0;
  tickResult = true;
  async liveActive(): Promise<boolean> {
    this.checks++;
    return this.watching;
  }
  async liveTick(_eq: string, t: number, v: Record<string, number>): Promise<boolean> {
    if (!this.watching || !this.tickResult) return false;
    this.ticks.push({ t, v });
    return true;
  }
}

let db: FakeDb;
let store: LiveFakeStore;
let nowMs: number;
let counter: number;
let published: { topic: string; payload: Buffer }[];
let svc: IngestService;
let seq = 0;

const sealUp = (name: "data" | "hb", body: unknown) => seal(body, { equipmentKey: key, equipmentId: EQ, direction: "up", topic: upTopic(EQ, name), counter: ++counter });
const heartbeat = () => svc.handleUp(EQ, "hb", sealUp("hb", { boot: 7, uptime_s: 100, inverter_online: true, map_ver: 1 }));
// pv1_power_w = register 186, battery_soc_pct = 184 (both shown to customers in the catalogue)
const frame = (pv: number, soc = 80) => svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [{ t: nowMs, seq: ++seq, blocks: [[186, [pv]], [184, [soc]]] }] }));
const commands = () => published.filter((p) => p.topic === dnTopic(EQ, "cmd")).map((p) => open<Record<string, unknown>>(p.payload, { equipmentKey: key, equipmentId: EQ, direction: "dn", topic: dnTopic(EQ, "cmd") }).body);
const liveCommands = () => commands().filter((c) => c.type === "live");
const step = async (ms: number) => {
  nowMs += ms;
  await heartbeat();
  await svc.tick(nowMs);
};

beforeEach(async () => {
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  await db.createKey({ equipmentId: EQ, kind: "gateway", ciphertext: vault.encrypt(key, { equipmentId: EQ, kind: "gateway" }), fingerprint: "abcdef012345", actor: "a" });
  store = new LiveFakeStore();
  nowMs = S * 1000 + 5000;
  counter = 0;
  seq = 0;
  published = [];
  svc = new IngestService({
    keys: new KeyCache(db, vault, 30_000, () => nowMs),
    store,
    liveStore: store,
    publish: async (_id, topic, payload) => {
      published.push({ topic, payload });
    },
    log: silent,
    now: () => nowMs,
  });
  await heartbeat();
});

describe("Go Live", () => {
  it("does nothing while nobody watches: no command to the board, no ticks", async () => {
    await step(4000);
    await frame(1200);
    await step(4000);
    expect(liveCommands()).toHaveLength(0);
    expect(store.ticks).toHaveLength(0);
  });

  it("tells the board to stream when somebody watches, and renews it every 30 seconds", async () => {
    store.watching = true;
    await step(4000);
    expect(liveCommands()).toHaveLength(1);
    expect(liveCommands()[0]).toMatchObject({ type: "live", seconds: 90 });
    expect((liveCommands()[0]!.expires_at as number) - (liveCommands()[0]!.issued_at as number)).toBeLessThanOrEqual(60_000);
    await step(10_000);
    expect(liveCommands()).toHaveLength(1); // not repeated at once
    await step(25_000);
    expect(liveCommands()).toHaveLength(2); // renewed
  });

  it("passes each reading on as a tick with the decoded values", async () => {
    store.watching = true;
    await step(4000); // learns that somebody watches
    await frame(1200, 77);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ticks).toHaveLength(1);
    expect(store.ticks[0]).toEqual({ t: nowMs, v: expect.objectContaining({ pv1_power_w: 1200, battery_soc_pct: 77 }) });
  });

  it("merges readings that arrive within a second into one tick", async () => {
    store.watching = true;
    await step(4000);
    await frame(1000);
    await frame(1100); // same instant: merged, sent at the next opportunity
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ticks).toHaveLength(1);
    nowMs += 1000;
    await frame(1300);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ticks).toHaveLength(2);
    expect(store.ticks[1]!.v.pv1_power_w).toBe(1300);
  });

  it("tells the board to stop when the viewer has gone, and sends no more ticks", async () => {
    store.watching = true;
    await step(4000);
    store.watching = false;
    await step(4000);
    const live = liveCommands();
    expect(live.at(-1)).toMatchObject({ type: "live", seconds: 0 });
    const before = store.ticks.length;
    await frame(900);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ticks).toHaveLength(before);
    await step(4000);
    expect(liveCommands()).toHaveLength(live.length); // stop is sent once
  });

  it("stops collecting when the database says nobody is watching any more", async () => {
    store.watching = true;
    await step(4000);
    store.tickResult = false;
    await frame(900);
    await new Promise((r) => setTimeout(r, 5));
    nowMs += 1000;
    await frame(950);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ticks).toHaveLength(0);
  });

  it("does not even ask while the board is silent", async () => {
    store.watching = true;
    const checks = store.checks;
    nowMs += 120_000; // no heartbeat since
    await svc.tick(nowMs);
    expect(store.checks).toBe(checks);
    expect(liveCommands()).toHaveLength(0);
  });
});
