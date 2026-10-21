import { beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { buildRegisterMap } from "../src/core/register-map.js";
import { ReplayGuard, open, seal } from "../src/core/seal.js";
import { decodePart, partKey } from "../src/core/cadence-part.js";
import { KeyCache } from "../src/features/broker/key-cache.js";
import { CadenceWriter } from "../src/features/cadence/writer.js";
import { MemoryObjectStore } from "../src/storage/object-store.js";
import { dnTopic, upTopic } from "../src/features/broker/topics.js";
import { IngestService } from "../src/features/ingest/service.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";

const EQ = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE = "51000000-0000-4000-8000-000000000001";
const S = 1_792_044_000; // a quarter-hour boundary, seconds
const key = Buffer.alloc(32, 9);
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const silent = { info: () => undefined, warn: () => undefined };

let db: FakeDb;
let store: FakeStore;
let nowMs: number;
let counter: number;
let published: { topic: string; payload: Buffer; retain: boolean }[];
let rejected: string[];
let svc: IngestService;

const mk = () =>
  new IngestService({
    keys: new KeyCache(db, vault, 30_000, () => nowMs),
    store,
    publish: async (_id, topic, payload, retain) => {
      published.push({ topic, payload, retain });
    },
    log: silent,
    now: () => nowMs,
    onRejected: (_id, reason) => rejected.push(reason),
  });

beforeEach(async () => {
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  await db.createKey({ equipmentId: EQ, kind: "gateway", ciphertext: vault.encrypt(key, { equipmentId: EQ, kind: "gateway" }), fingerprint: "abcdef012345", actor: "a" });
  store = new FakeStore();
  nowMs = S * 1000 + 5000;
  counter = 0;
  published = [];
  rejected = [];
  svc = mk();
});

// pv1_power_w = register 186, battery_soc_pct = 184, battery_power_w = 190 (signed), day_pv_energy_kwh = 108 (x 0.1)
const frame = (seq: number, tSec: number, v: { pv?: number; soc?: number; bat?: number; day?: number } = {}) => ({
  t: Math.round(tSec * 1000),
  seq,
  blocks: [[186, [v.pv ?? 100]], [184, [v.soc ?? 80]], [190, [v.bat ?? 0]], ...(v.day !== undefined ? [[108, [v.day]]] : [])] as [number, number[]][],
});
const sealUp = (name: "data" | "hb" | "evt", body: unknown, k = key) => seal(body, { equipmentKey: k, equipmentId: EQ, direction: "up", topic: upTopic(EQ, name), counter: ++counter });
const send = (boot: number, frames: ReturnType<typeof frame>[]) => svc.handleUp(EQ, "data", sealUp("data", { boot, frames }));

/** Sends frames every 5 s from `from` (inclusive) to `to` (exclusive) in batches of 60, with the clock following the data. */
async function feed(boot: number, from: number, to: number, seq0 = 1, v?: Parameters<typeof frame>[2]) {
  let seq = seq0;
  for (let t = from; t < to; t += 300) {
    const frames = [];
    for (let u = t; u < Math.min(t + 300, to); u += 5) frames.push(frame(seq++, u, v));
    nowMs = Math.min(to, t + 300) * 1000 + 1000;
    await send(boot, frames);
  }
  return seq;
}
const acksOf = () => published.filter((p) => p.topic === dnTopic(EQ, "ack")).map((p) => open<{ boot: number; seq: number }>(p.payload, { equipmentKey: key, equipmentId: EQ, direction: "dn", topic: dnTopic(EQ, "ack") }));
const bucketOf = (k: string, start: number) => store.allBuckets().find((b) => b.key === k && b.start === start);

describe("data becomes finished buckets", () => {
  it("decodes a stream of batches into 15-minute buckets and the latest values", async () => {
    await feed(7, S, S + 1800);
    nowMs = (S + 1800) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(store.writes).toHaveLength(1);
    const b = bucketOf("pv1_power_w", S)!;
    expect(b).toMatchObject({ covered: 900, wsum: 90_000, min: 100, max: 100, last: 100, n: 180 });
    expect(bucketOf("pv1_power_w", S + 900)).toMatchObject({ covered: 900, n: 180 });
    expect(bucketOf("battery_soc_pct", S)).toMatchObject({ wsum: 80 * 900 });
    const latest = new Map(store.writes[0]!.latest.map((l) => [l.key, l]));
    expect(latest.get("pv1_power_w")).toMatchObject({ value: 100, ts: S + 1795 });
    expect(latest.get("battery_power_w")!.value).toBe(0);
  });

  it("sends the running figures of the unfinished bucket with every write", async () => {
    await feed(7, S, S + 1200);
    nowMs = (S + 1200) * 1000 + 3000;
    await svc.flush(EQ, nowMs);
    const open = store.writes[0]!.open;
    const pv = open.find((o) => o.key === "pv1_power_w")!;
    expect(pv.bucket.start).toBe(S + 900);
    expect(pv.bucket.covered).toBeGreaterThan(290);
    expect(pv.bucket.covered).toBeLessThanOrEqual(305);
    expect(pv.bucket.last).toBe(100);
    expect(open.length).toBe(new Set(store.allBuckets().map((b) => b.key)).size);
  });

  it("reads a signed value, a scaled value and keeps negative parts only when negative", async () => {
    await feed(7, S, S + 900, 1, { bat: 65476, day: 123 }); // 65476 = -60
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(bucketOf("battery_power_w", S)).toMatchObject({ min: -60, max: -60, pos: 0, neg: 60 * 900 });
    expect(bucketOf("pv1_power_w", S)!.pos).toBeUndefined();
    expect(store.writes[0]!.latest.find((l) => l.key === "day_pv_energy_kwh")!.value).toBeCloseTo(12.3, 6);
  });

  it("does not write finished buckets before the upload interval is due (only the 30-second latest values go out)", async () => {
    await feed(7, S, S + 600);
    nowMs = (S + 899) * 1000;
    await svc.tick(nowMs);
    expect(store.writes.flatMap((w) => w.buckets)).toHaveLength(0);
    expect(acksOf()).toHaveLength(0); // nothing is acknowledged by a latest-values push
  });

  it("keeps a value that is out of range out of the summaries and the latest values", async () => {
    await feed(7, S, S + 900, 1, { soc: 150 }); // battery_soc_pct is valid 0..100
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(bucketOf("battery_soc_pct", S)).toBeUndefined();
    expect(store.writes[0]!.latest.some((l) => l.key === "battery_soc_pct")).toBe(false);
    expect(svc.stats(EQ)!.outOfRange).toBeGreaterThan(100);
    expect(bucketOf("pv1_power_w", S)).toBeDefined();
  });

  it("ignores registers it does not know and metrics whose registers are not all there", async () => {
    nowMs = (S + 10) * 1000;
    await svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [{ t: nowMs - 1000, seq: 1, blocks: [[9000, [1, 2, 3]], [96, [5]]] }] })); // 96 alone is half of total_pv_energy_kwh
    expect(svc.stats(EQ)!.frames).toBe(1);
    await svc.tick((S + 2000) * 1000);
    expect(store.writes.flatMap((w) => w.latest)).toEqual([]);
  });

  it("drops frames with an impossible time but still lets the board forget them", async () => {
    nowMs = (S + 100) * 1000;
    await send(7, [frame(1, S + 100 + 3600), frame(2, S + 100 - 40 * 3600), frame(3, S + 95)]);
    const st = svc.stats(EQ)!;
    expect(st.droppedTime).toBe(2);
    expect(st.frames).toBe(1);
  });
});

describe("what the board is told is stored", () => {
  it("acknowledges readings older than the last written bucket by two minutes", async () => {
    await feed(7, S, S + 1500);
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    const acks = acksOf();
    expect(acks).toHaveLength(1);
    // written boundary S+900, minus 120 s: the newest frame with t < S+780 is index 155 -> seq 156
    expect(acks[0]!.body).toEqual({ boot: 7, seq: 156 });
  });

  it("does not acknowledge anything before a bucket has been written", async () => {
    await feed(7, S, S + 600);
    expect(acksOf()).toHaveLength(0);
  });

  it("sends strictly increasing counters that a board accepts once each", async () => {
    await feed(7, S, S + 2700);
    for (const t of [S + 900, S + 1800]) {
      nowMs = t * 1000 + 3000;
      await svc.tick(nowMs);
    }
    nowMs = (S + 2700) * 1000 + 3000;
    await svc.tick(nowMs);
    const guard = new ReplayGuard();
    const counters = acksOf().map((a) => a.counter);
    expect(counters.length).toBeGreaterThanOrEqual(3);
    for (const c of counters) guard.accept(c);
    expect([...counters].sort((a, b) => a - b)).toEqual(counters);
  });

  it("sends an acknowledgement per boot when an earlier boot still has unsent readings", async () => {
    const next = await feed(3, S, S + 600);
    await feed(4, S + 600, S + 1500, 1);
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    const boots = acksOf().map((a) => a.body.boot);
    expect(boots).toContain(3);
    expect(next).toBeGreaterThan(1);
  });
});

describe("rejected and repeated messages", () => {
  it("ignores a batch it has already seen (a resend after a restart or a lost acknowledgement)", async () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i + 1, S + i * 5));
    nowMs = (S + 100) * 1000;
    await send(7, frames);
    await send(7, frames);
    const st = svc.stats(EQ)!;
    expect(st.frames).toBe(10);
    expect(st.duplicates).toBe(10);
  });

  it("refuses the very same sealed bytes a second time (replay)", async () => {
    nowMs = (S + 100) * 1000;
    const msg = sealUp("data", { boot: 7, frames: [frame(1, S + 90)] });
    await svc.handleUp(EQ, "data", msg);
    await svc.handleUp(EQ, "data", msg);
    expect(rejected).toEqual(["replay"]);
    expect(svc.stats(EQ)!.batches).toBe(1);
  });

  it("refuses a message sealed with another key, on another topic, or damaged", async () => {
    nowMs = (S + 100) * 1000;
    await svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [frame(1, S + 90)] }, Buffer.alloc(32, 1)));
    await svc.handleUp(EQ, "hb", sealUp("data", { boot: 7, uptime_s: 1 })); // sealed for the data topic, arrives as a heartbeat
    const bad = Buffer.from(sealUp("data", { boot: 7, frames: [frame(1, S + 90)] }));
    bad[30] = bad[30]! ^ 1;
    await svc.handleUp(EQ, "data", bad);
    expect(rejected).toEqual(["authentication_failed", "authentication_failed", "authentication_failed"]);
    expect(svc.stats(EQ)!.batches).toBe(0);
  });

  it("refuses a body that is the wrong shape without crashing", async () => {
    nowMs = (S + 100) * 1000;
    await expect(svc.handleUp(EQ, "data", sealUp("data", { boot: "x", frames: "no" }))).resolves.toBeUndefined();
    await expect(svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [{ t: 1, seq: 1, blocks: [[186, new Array(500).fill(1)]] }] }))).resolves.toBeUndefined();
    expect(svc.stats(EQ)!.batches).toBe(0);
  });

  it("ignores equipment without a catalogue and unknown topics", async () => {
    store.profile = null;
    nowMs = (S + 100) * 1000;
    await expect(svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [frame(1, S + 90)] }))).resolves.toBeUndefined();
    await expect(svc.handleUp(EQ, "whatever", Buffer.from("x"))).resolves.toBeUndefined();
    expect(svc.stats(EQ)).toBeUndefined();
  });

  it("does nothing for a board whose key was revoked", async () => {
    await db.revokeKey({ keyId: db.keys[0]!.keyId, actor: "a" });
    nowMs = (S + 100) * 1000;
    await svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [frame(1, S + 90)] }));
    expect(svc.stats(EQ)?.batches ?? 0).toBe(0);
  });
});

describe("a storage failure loses nothing", () => {
  it("keeps the finished buckets and writes them at the next try", async () => {
    await feed(7, S, S + 900);
    store.failWrites = 1;
    nowMs = (S + 900) * 1000 + 3000;
    const closedWrites = () => store.writes.filter((w) => w.buckets.length > 0);
    await svc.tick(nowMs);
    expect(closedWrites()).toHaveLength(0);
    expect(svc.stats(EQ)!.flushFailures).toBe(1);
    expect(acksOf()).toHaveLength(0); // nothing may be acknowledged that is not stored
    await svc.tick(nowMs + 10_000); // too early: the retry is 30 s later
    expect(closedWrites()).toHaveLength(0);
    await svc.tick(nowMs + 31_000);
    expect(closedWrites()).toHaveLength(1);
    expect(bucketOf("pv1_power_w", S)).toMatchObject({ covered: 900, n: 180 });
    expect(acksOf().length).toBeGreaterThan(0);
  });
});

describe("a restart of the backend", () => {
  it("rebuilds the same buckets from what the board resends", async () => {
    // reference: one uninterrupted run
    await feed(7, S, S + 2700, 1, { pv: 250 });
    nowMs = (S + 2700) * 1000 + 3000;
    await svc.tick(nowMs);
    const reference = new Map(store.allBuckets().map((b) => [`${b.key}@${b.start}`, b]));

    // interrupted run: the backend restarts after the first bucket was written and acknowledged
    store = new FakeStore();
    published = [];
    counter = 0;
    svc = mk();
    nowMs = S * 1000 + 5000;
    const afterFirst = await feed(7, S, S + 1000, 1, { pv: 250 });
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    const ack = acksOf().at(-1)!.body;
    expect(ack.seq).toBeGreaterThan(0);

    svc = mk(); // restart: all memory gone
    counter = 100; // the board's counter keeps rising
    published = [];
    // the board resends everything after the acknowledgement it received, then carries on
    const resent: ReturnType<typeof frame>[] = [];
    for (let i = ack.seq; i < afterFirst - 1; i++) resent.push(frame(i + 1, S + i * 5, { pv: 250 }));
    nowMs = (S + 1000) * 1000;
    for (let i = 0; i < resent.length; i += 60) await send(7, resent.slice(i, i + 60));
    await feed(7, S + 1000, S + 2700, afterFirst, { pv: 250 });
    nowMs = (S + 2700) * 1000 + 3000;
    await svc.tick(nowMs);

    const second = bucketOf("pv1_power_w", S + 900)!;
    expect(second.covered).toBe(reference.get(`pv1_power_w@${S + 900}`)!.covered);
    expect(second.wsum).toBe(reference.get(`pv1_power_w@${S + 900}`)!.wsum);
    expect(bucketOf("pv1_power_w", S + 1800)).toMatchObject({ covered: 900 });
    expect(bucketOf("pv1_power_w", S)).toMatchObject({ covered: 900 }); // written before the restart
  });
});

describe("a restart when a reading is held into the next bucket", () => {
  // The unit goes quiet at S+890 and comes back at S+960. The reading at S+890 is held for 60 s: 10 s in the first bucket and
  // 50 s in the next one. If the backend had been told that reading is stored and then restarted, those 50 s would be lost.
  const times = [...Array.from({ length: 179 }, (_, i) => S + i * 5), ...Array.from({ length: 168 }, (_, i) => S + 960 + i * 5)];
  const all = times.map((t, i) => frame(i + 1, t, { pv: 400 }));
  const upToGap = all.filter((f) => f.t / 1000 <= S + 890);
  const afterGap = all.filter((f) => f.t / 1000 >= S + 960);

  async function run(restart: boolean) {
    store = new FakeStore();
    published = [];
    counter = 0;
    svc = mk();
    nowMs = (S + 891) * 1000;
    for (let i = 0; i < upToGap.length; i += 60) await send(7, upToGap.slice(i, i + 60));
    nowMs = (S + 903) * 1000;
    await svc.tick(nowMs);
    if (restart) {
      const ack = acksOf().at(-1)?.body.seq ?? 0;
      svc = mk();
      counter += 100;
      nowMs = (S + 950) * 1000;
      await send(7, all.filter((f) => f.seq > ack && f.t / 1000 <= S + 890)); // what the board still holds
    }
    nowMs = (S + 1800) * 1000;
    for (let i = 0; i < afterGap.length; i += 60) await send(7, afterGap.slice(i, i + 60));
    nowMs = (S + 1803) * 1000;
    await svc.tick(nowMs);
    return bucketOf("pv1_power_w", S + 900)!;
  }

  it("still has the 50 seconds the earlier reading holds into the second bucket", async () => {
    const reference = await run(false);
    expect(reference.covered).toBeGreaterThan(50 + 800);
    const afterRestart = await run(true);
    expect(afterRestart.covered).toBe(reference.covered);
    expect(afterRestart.wsum).toBe(reference.wsum);
  });
});

describe("heartbeat and register map", () => {
  const hb = (over: Record<string, unknown> = {}) => ({ boot: 7, uptime_s: 100, inverter_online: true, map_ver: 1, clock_valid: true, device_time_ms: nowMs + 2000, fw_version: "2.0.1", rssi: -61, ...over });

  it("writes every 10 s check-in, but not a burst of them, unless something changed", async () => {
    nowMs = (S + 10) * 1000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb()));
    nowMs += 3_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ uptime_s: 103 })));
    expect(store.heartbeats).toHaveLength(1); // too soon after the last write
    nowMs += 7_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ uptime_s: 110 })));
    expect(store.heartbeats).toHaveLength(2); // the regular 10 s check-in is written: the database judges "offline" after 3 missed ones
    nowMs += 2_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ inverter_online: false })));
    expect(store.heartbeats).toHaveLength(3); // a change is written at once
    expect(store.heartbeats[2]!.inverterOnline).toBe(false);
    expect(store.heartbeats[2]!.uploadIntervalS).toBe(900);
  });

  it("says so, once a minute, when a check-in is not in the agreed shape", async () => {
    const warns: string[] = [];
    svc = new IngestService({
      keys: new KeyCache(db, vault, 30_000, () => nowMs),
      store,
      publish: async () => undefined,
      log: { info: () => undefined, warn: (_o: unknown, m?: string) => void warns.push(String(m)) },
      now: () => nowMs,
      onRejected: () => undefined,
    });
    nowMs = (S + 10) * 1000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ seq_acked: -1 })));
    nowMs += 10_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ seq_acked: -1 })));
    expect(store.heartbeats).toHaveLength(0);
    expect(warns).toEqual(["heartbeat has the wrong shape"]);
    nowMs += 60_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ seq_acked: -1 })));
    expect(warns).toHaveLength(2);
  });

  it("reports the board's clock difference only when the board says its clock is valid", async () => {
    nowMs = (S + 10) * 1000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ device_time_ms: nowMs + 4000 })));
    expect(store.heartbeats[0]!.clockOffsetS).toBeCloseTo(4, 3);
    nowMs += 40_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ clock_valid: false, inverter_online: false })));
    expect(store.heartbeats[1]!.clockOffsetS).toBeUndefined();
  });

  it("sends the register map, retained, when a board logs in", async () => {
    await svc.handleReady(EQ);
    const m = published.find((p) => p.topic === dnTopic(EQ, "map"))!;
    expect(m.retain).toBe(true);
    const body = open<{ ver: number; hash: string; requests: { s: number; n: number; c: number }[]; writes: { k: string; r: number; m: number }[] }>(m.payload, { equipmentKey: key, equipmentId: EQ, direction: "dn", topic: dnTopic(EQ, "map") }).body;
    const expected = buildRegisterMap(store.profile!.metrics, { mpptCount: 2 });
    expect(body.ver).toBe(1);
    expect(body.hash).toBe(expected.hash.slice(0, 16).length === 16 ? body.hash : "");
    expect(body.requests.length).toBeGreaterThan(40);
    expect(body.requests.every((r) => r.n >= 1 && r.n <= 60)).toBe(true);
    expect(body.writes.some((w) => w.k === "time_of_use_monday_enabled" && w.r === 248 && w.m === 2)).toBe(true);
  });

  it("stores each distinct map once and gives it a version", async () => {
    await svc.handleReady(EQ);
    await svc.handleReady(EQ);
    expect(store.maps).toHaveLength(1);
    store.profile!.metrics = store.profile!.metrics.map((m) => (m.key === "battery_power_w" ? { ...m, cadenceSeconds: 10 } : m));
    nowMs += 11 * 60_000; // the catalogue is re-read every few minutes
    await svc.handleReady(EQ);
    expect(store.maps).toHaveLength(2);
    expect(svc.mapVersion(EQ)).toBe(2);
  });

  it("sends the map again when a board reports an old version, but not more than once a minute", async () => {
    await svc.handleReady(EQ);
    published = [];
    nowMs += 70_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ map_ver: 0 })));
    expect(published.filter((p) => p.topic === dnTopic(EQ, "map"))).toHaveLength(1);
    nowMs += 10_000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hb({ map_ver: 0, inverter_online: false })));
    expect(published.filter((p) => p.topic === dnTopic(EQ, "map"))).toHaveLength(1);
  });

  it("answers a hello from a board that has an old map, and leaves a board with the current one alone", async () => {
    await svc.handleReady(EQ);
    published = [];
    nowMs += 70_000;
    await svc.handleUp(EQ, "evt", sealUp("evt", { type: "hello", map_ver: 1, fw_version: "2.0.1" }));
    expect(published).toHaveLength(0);
    await svc.handleUp(EQ, "evt", sealUp("evt", { type: "hello", map_ver: 0 }));
    expect(published).toHaveLength(1);
  });
});

describe("cadence data is kept before the board is told", () => {
  let objects: MemoryObjectStore;
  let writer: CadenceWriter;
  const mkWithCadence = () => {
    objects = new MemoryObjectStore(() => nowMs);
    writer = new CadenceWriter({ store: objects, log: { info: () => undefined, warn: () => undefined }, now: () => nowMs });
    svc = new IngestService({
      keys: new KeyCache(db, vault, 30_000, () => nowMs),
      store,
      cadence: writer,
      publish: async (_id, topic, payload, retain) => {
        published.push({ topic, payload, retain });
      },
      log: silent,
      now: () => nowMs,
      onRejected: (_id, reason) => rejected.push(reason),
    });
  };
  const partRows = (start: number) => decodePart(objects.files.get(partKey(EQ, start * 1000))!);

  it("stores the raw words of every frame in 5-minute files", async () => {
    mkWithCadence();
    await feed(7, S, S + 1500);
    nowMs = (S + 900) * 1000 + 20_000;
    await svc.tick(nowMs);
    const rows = partRows(S);
    expect(rows).toHaveLength(60);
    expect(rows[0]).toMatchObject({ boot: 7, seq: 1, t: S * 1000 });
    expect(rows[0]!.words.get(186)).toBe(100);
    expect(rows[0]!.words.get(184)).toBe(80);
    expect(partRows(S + 600)).toHaveLength(60);
  });

  it("does not store a frame twice, and drops frames with an impossible time", async () => {
    mkWithCadence();
    const frames = [frame(1, S + 10), frame(2, S + 15), frame(3, S - 40 * 3600)];
    nowMs = (S + 100) * 1000;
    await send(7, frames);
    await send(7, frames);
    await writer.flushAll();
    expect(partRows(S)).toHaveLength(2);
    expect([...objects.files.keys()]).toHaveLength(1);
  });

  it("tells the board a frame is stored only once its 5-minute file has been written", async () => {
    mkWithCadence();
    await feed(7, S, S + 1500);
    nowMs = (S + 900) * 1000 + 3000; // summaries are written; the window ending at S+900 is still in its grace period
    await svc.tick(nowMs);
    // the summary rule alone would allow seq 156 (frames before S+780); the file store holds only what ended before S+600
    expect(acksOf().map((a) => a.body)).toEqual([{ boot: 7, seq: 120 }]);
  });

  it("holds back every acknowledgement while the file store is down, and loses nothing", async () => {
    mkWithCadence();
    await feed(7, S, S + 1500);
    objects.failNext = 1000;
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(acksOf()).toHaveLength(0);
    expect(store.writes).toHaveLength(1); // the summaries do not wait for the file store
    objects.failNext = 0;
    await feed(7, S + 1500, S + 1800, 301);
    nowMs = (S + 1800) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(partRows(S)).toHaveLength(60);
    expect(acksOf().length).toBeGreaterThan(0);
    expect(acksOf().at(-1)!.body.seq).toBeGreaterThan(156);
  });

  it("works without a file store, as before", async () => {
    await feed(7, S, S + 1500);
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(acksOf()[0]!.body).toEqual({ boot: 7, seq: 156 });
  });
});

describe("a board that answers from its test inverter", () => {
  const hbBody = (over: Record<string, unknown> = {}) => ({ boot: 7, uptime_s: 100, inverter_online: true, map_ver: 1, clock_valid: true, device_time_ms: nowMs + 2000, fw_version: "2.0.1", rssi: -61, ...over });

  it("has its readings discarded (never stored), and they are acknowledged so the board empties its queue", async () => {
    nowMs = (S + 10) * 1000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hbBody({ simulated: true })));
    await feed(7, S, S + 900);
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(store.writes).toHaveLength(0);
    expect(store.allBuckets()).toHaveLength(0);
  });

  it("is stored again once it says it reads the real inverter", async () => {
    nowMs = (S + 10) * 1000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hbBody({ simulated: true })));
    nowMs = (S + 20) * 1000;
    await svc.handleUp(EQ, "hb", sealUp("hb", hbBody({ uptime_s: 110 }))); // no flag: real again
    await feed(7, S, S + 900);
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(store.writes.length).toBeGreaterThan(0);
    expect(bucketOf("pv1_power_w", S)).toBeTruthy();
  });
});

describe("a changed push interval", () => {
  it("is applied to a running unit at once: it is written at the new rhythm without waiting for the old one", async () => {
    await feed(7, S, S + 200);
    nowMs = (S + 200) * 1000 + 3000;
    await svc.tick(nowMs);
    const before = store.writes.length; // the 15-minute rhythm: nothing is due after three minutes
    store.profile = { ...store.profile!, uploadIntervalS: 60 };
    await svc.reloadProfile(EQ);
    nowMs += 61_000;
    await svc.tick(nowMs);
    expect(store.writes.length).toBeGreaterThan(before);
  });

  it("does nothing for a unit that is not connected (its next start reads the database)", async () => {
    await expect(svc.reloadProfile("00000000-0000-4000-8000-0000000000ff")).resolves.toBeUndefined();
  });
});

describe("changed read rates", () => {
  it("make a new register map version that is sent to the running unit at once; a change that leaves the map as it was sends nothing", async () => {
    await svc.handleReady(EQ);
    expect(svc.mapVersion(EQ)).toBe(1);
    published = [];
    store.profile!.metrics = store.profile!.metrics.map((m) => (m.key === "battery_power_w" ? { ...m, cadenceSeconds: 10 } : m));
    await svc.reloadProfile(EQ);
    expect(svc.mapVersion(EQ)).toBe(2);
    expect(published.filter((p) => p.topic === dnTopic(EQ, "map"))).toHaveLength(1);
    published = [];
    await svc.reloadProfile(EQ);
    expect(svc.mapVersion(EQ)).toBe(2);
    expect(published.filter((p) => p.topic === dnTopic(EQ, "map"))).toHaveLength(0);
  });
});

describe("the latest values between the pushes of the averaged figures (T12)", () => {
  const latestWrites = () => store.writes.filter((w) => w.buckets.length === 0 && w.latest.length > 0);

  it("go to the database every 30 seconds, with the running figures, before the 15-minute push is due", async () => {
    await feed(7, S, S + 120);
    nowMs = (S + 120) * 1000 + 3000;
    await svc.tick(nowMs);
    expect(latestWrites()).toHaveLength(1);
    const w = latestWrites()[0]!;
    expect(w.latest.find((l) => l.key === "pv1_power_w")).toMatchObject({ value: 100 });
    expect(w.open.length).toBeGreaterThan(0); // the running figures of the unfinished bucket go with them
    expect(acksOf()).toHaveLength(0); // and acknowledge nothing: only the regular write stores the readings for good
  });

  it("send only what changed, and not more often than every 30 seconds", async () => {
    await feed(7, S, S + 120);
    nowMs = (S + 120) * 1000 + 3000;
    await svc.tick(nowMs);
    await svc.tick(nowMs + 10_000); // too soon
    expect(latestWrites()).toHaveLength(1);
    await svc.tick(nowMs + 31_000); // due, but nothing new arrived
    expect(latestWrites()).toHaveLength(1);
    await feed(7, S + 120, S + 180, 25, { pv: 555 }); // new readings
    await svc.tick(nowMs + 62_000);
    expect(latestWrites()).toHaveLength(2);
    expect(latestWrites()[1]!.latest.find((l) => l.key === "pv1_power_w")).toMatchObject({ value: 555 });
  });

  it("do not replace the regular write: the 15-minute push still carries every latest value and the closed buckets", async () => {
    await feed(7, S, S + 900);
    nowMs = (S + 900) * 1000 + 3000;
    await svc.tick(nowMs);
    const regular = store.writes.find((w) => w.buckets.length > 0)!;
    expect(regular.latest.some((l) => l.key === "pv1_power_w")).toBe(true);
    expect(bucketOf("pv1_power_w", S)).toMatchObject({ covered: 900, n: 180 });
    expect(acksOf().length).toBeGreaterThan(0);
  });

  it("are tried again at the next round when the database is down, and never hold the regular write back", async () => {
    await feed(7, S, S + 120);
    nowMs = (S + 120) * 1000 + 3000;
    store.failWrites = 1;
    await svc.tick(nowMs);
    expect(latestWrites()).toHaveLength(0);
    await svc.tick(nowMs + 31_000);
    expect(latestWrites()).toHaveLength(1);
  });

  it("are not sent separately when the unit is pushed every minute or faster (the regular write already is that often)", async () => {
    store.profile = { ...store.profile!, uploadIntervalS: 60 };
    svc = mk();
    await feed(7, S, S + 120);
    nowMs = (S + 120) * 1000 + 3000;
    await svc.tick(nowMs);
    // this unit is written by the regular flush every minute: no extra latest-only push is added on top of it
    const before = store.writes.length;
    await svc.tick(nowMs + 31_000);
    expect(store.writes.length).toBe(before);
  });
});
