import { beforeEach, describe, expect, it } from "vitest";
import { WINDOW_MS, decodePart, partKey } from "../src/core/cadence-part.js";
import { CadenceArchive } from "../src/features/cadence/archive.js";
import { CadenceWriter } from "../src/features/cadence/writer.js";
import { MemoryObjectStore } from "../src/storage/object-store.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const T0 = Date.UTC(2026, 9, 15, 8, 5, 0);
const warns: string[] = [];
const log = { info: () => undefined, warn: (_o: object, m?: string) => void warns.push(String(m)) };

let now: number;
let store: MemoryObjectStore;
let writer: CadenceWriter;
const frame = (t: number, seq: number, pv = 120, boot = 7) => ({ t, boot, seq, blocks: [[186, [pv]], [184, [80]]] as [number, number[]][] });
const parts = () => [...store.files.keys()].filter((k) => k.endsWith(".csv.gz") && !k.endsWith("day.csv.gz")).sort();
const rowsOf = (key: string) => decodePart(store.files.get(key)!);

beforeEach(() => {
  warns.length = 0;
  now = T0 + 60_000;
  store = new MemoryObjectStore(() => now);
  writer = new CadenceWriter({ store, log, now: () => now });
});

describe("writing windows", () => {
  it("writes a window only once it has ended, as one file", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1), frame(T0 + 6000, 2), frame(T0 + 299_000, 60)]);
    await writer.tick(T0 + 120_000);
    expect(parts()).toEqual([]);
    await writer.tick(T0 + WINDOW_MS + 5_000);
    expect(parts()).toEqual([]); // still in the grace period for frames on their way
    await writer.tick(T0 + WINDOW_MS + 16_000);
    expect(parts()).toEqual([partKey(EQ, T0)]);
    expect(rowsOf(partKey(EQ, T0)).map((r) => r.seq)).toEqual([1, 2, 60]);
  });

  it("splits frames into their own windows", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1), frame(T0 + WINDOW_MS + 1000, 2), frame(T0 + 2 * WINDOW_MS + 1000, 3)]);
    await writer.tick(T0 + 3 * WINDOW_MS + 20_000);
    expect(parts()).toHaveLength(3);
    expect(rowsOf(partKey(EQ, T0 + WINDOW_MS)).map((r) => r.seq)).toEqual([2]);
  });

  it("writes nothing twice when nothing changed", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1)]);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    await writer.tick(T0 + WINDOW_MS + 30_000);
    expect(store.writes).toBe(1);
  });

  it("keeps a frame that is sent twice once", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1), frame(T0 + 1000, 1)]);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    expect(rowsOf(partKey(EQ, T0))).toHaveLength(1);
  });

  it("ignores a frame that carries no registers", async () => {
    writer.add(EQ, [{ t: T0, boot: 7, seq: 1, blocks: [] }]);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    expect(parts()).toEqual([]);
  });
});

describe("late frames", () => {
  it("rewrite the window with the earlier frames still in it", async () => {
    now = T0 - 1000; // this process was already running when the window began
    writer = new CadenceWriter({ store, log, now: () => now });
    writer.add(EQ, [frame(T0 + 1000, 1)]);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    writer.add(EQ, [frame(T0 + 2000, 2)]);
    await writer.tick(T0 + WINDOW_MS + 30_000);
    expect(rowsOf(partKey(EQ, T0)).map((r) => r.seq)).toEqual([1, 2]);
    expect(store.reads).toBe(0); // the window was still in memory: no read of the file
  });

  it("after a restart, join with the file written before it", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1), frame(T0 + 6000, 2)]);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    // a new process starts later, and the board resends frame 2 together with a new one for the same window
    now = T0 + 20 * 60_000;
    const restarted = new CadenceWriter({ store, log, now: () => now });
    restarted.add(EQ, [frame(T0 + 6000, 2), frame(T0 + 7000, 3)]);
    await restarted.tick(now);
    expect(rowsOf(partKey(EQ, T0)).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("join with the file even when the window was dropped from memory in the same run", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1)]);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    await writer.tick(T0 + WINDOW_MS + 11 * 60_000); // dropped from memory
    now = T0 + WINDOW_MS + 12 * 60_000;
    writer.add(EQ, [frame(T0 + 2000, 2)]);
    await writer.tick(now);
    expect(rowsOf(partKey(EQ, T0)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it("replace a damaged file instead of being stuck on it", async () => {
    store.files.set(partKey(EQ, T0), Buffer.from("garbage"));
    const w = new CadenceWriter({ store, log, now: () => now });
    w.add(EQ, [frame(T0 + 1000, 1)]);
    await w.tick(T0 + WINDOW_MS + 20_000);
    expect(rowsOf(partKey(EQ, T0)).map((r) => r.seq)).toEqual([1]);
    expect(warns).toContain("replacing an unreadable cadence file");
  });
});

describe("what is safe to acknowledge", () => {
  it("is everything before the oldest window not yet written", async () => {
    expect(writer.durableBeforeMs(EQ)).toBe(Infinity);
    writer.add(EQ, [frame(T0 + 1000, 1), frame(T0 + WINDOW_MS + 1000, 2)]);
    expect(writer.durableBeforeMs(EQ)).toBe(T0);
    await writer.tick(T0 + WINDOW_MS + 20_000);
    expect(writer.durableBeforeMs(EQ)).toBe(T0 + WINDOW_MS);
    await writer.tick(T0 + 2 * WINDOW_MS + 20_000);
    expect(writer.durableBeforeMs(EQ)).toBe(Infinity);
  });

  it("stays put while the file store is down, and the data is written when it is back", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1)]);
    store.failNext = 1;
    await writer.tick(T0 + WINDOW_MS + 20_000);
    expect(writer.durableBeforeMs(EQ)).toBe(T0);
    expect(writer.stats().failures).toBe(1);
    expect(warns).toContain("writing a cadence file failed, will retry");
    await writer.tick(T0 + WINDOW_MS + 40_000);
    expect(writer.durableBeforeMs(EQ)).toBe(Infinity);
    expect(parts()).toEqual([partKey(EQ, T0)]);
  });

  it("is kept separately for each equipment", () => {
    writer.add(EQ, [frame(T0 + 1000, 1)]);
    expect(writer.durableBeforeMs("aaaaaaaa-0000-4000-8000-000000000001")).toBe(Infinity);
  });

  it("flushAll writes a window that has not ended yet", async () => {
    writer.add(EQ, [frame(T0 + 1000, 1)]);
    await writer.flushAll();
    expect(parts()).toEqual([partKey(EQ, T0)]);
  });
});

describe("the archive", () => {
  const mk = (clock: () => number) => new CadenceArchive(store, log, clock);

  async function fillDay(day: number, windows: number[], writtenAt?: number) {
    if (writtenAt !== undefined) now = writtenAt;
    const seqBase = 1;
    writer.add(EQ, windows.map((i, n) => frame(day + i * WINDOW_MS + 1000, seqBase + n, 100 + i)));
    await writer.flushAll();
  }

  it("reads frames from parts for a range, oldest first, and no others", async () => {
    await fillDay(T0 - 5 * WINDOW_MS, [0, 1, 2, 3]);
    const rows = await mk(() => now).read(EQ, T0 - 4 * WINDOW_MS, T0 - 2 * WINDOW_MS);
    expect(rows.map((r) => r.seq)).toEqual([2, 3]);
  });

  it("reads across midnight (UTC) and across days", async () => {
    const d1 = Date.UTC(2026, 9, 14, 23, 50);
    writer.add(EQ, [frame(d1, 1), frame(d1 + 15 * 60_000, 2)]);
    await writer.flushAll();
    const rows = await mk(() => now).read(EQ, d1 - 1000, d1 + 20 * 60_000);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("joins a finished day into one file, and then reads that file", async () => {
    const day = Date.UTC(2026, 9, 14);
    await fillDay(day, [0, 1, 2, 100, 287], Date.UTC(2026, 9, 14, 23, 59));
    now = Date.UTC(2026, 9, 15, 3, 0, 0);
    const a = mk(() => now);
    expect(await a.mergeDay(EQ, day)).toBe(5);
    expect(store.files.has(`cadence/v1/${EQ}/2026/10/14/day.csv.gz`)).toBe(true);
    store.reads = 0;
    const rows = await a.read(EQ, day, day + 86_400_000);
    expect(rows).toHaveLength(5);
    expect(store.reads).toBe(1); // the day file only, not five parts
  });

  it("leaves a day alone when nothing is new, and does not join a day that is not over", async () => {
    const day = Date.UTC(2026, 9, 14);
    await fillDay(day, [0, 1], Date.UTC(2026, 9, 14, 23, 59));
    now = Date.UTC(2026, 9, 15, 3, 0, 0);
    const a = mk(() => now);
    await a.mergeDay(EQ, day);
    const writes = store.writes;
    expect(await a.mergeDay(EQ, day)).toBeNull();
    expect(store.writes).toBe(writes);
    expect(await mk(() => day + 3600_000).mergeDay(EQ, day)).toBeNull();
  });

  it("includes a frame that arrived after its day was joined", async () => {
    const day = Date.UTC(2026, 9, 14);
    await fillDay(day, [0, 1], Date.UTC(2026, 9, 14, 23, 59));
    now = Date.UTC(2026, 9, 15, 3, 0, 0);
    const a = mk(() => now);
    await a.mergeDay(EQ, day);
    now += 60_000;
    const late = new CadenceWriter({ store, log, now: () => now });
    late.add(EQ, [frame(day + WINDOW_MS + 2000, 99)]);
    await late.flushAll();
    expect((await a.read(EQ, day, day + 86_400_000)).map((r) => r.seq).sort((x, y) => x - y)).toEqual([1, 2, 99]);
    expect(await a.mergeDay(EQ, day)).toBe(3);
    now += 60_000;
    expect((await a.read(EQ, day, day + 86_400_000)).map((r) => r.seq).sort((x, y) => x - y)).toEqual([1, 2, 99]);
  });

  it("joins the last days of every equipment, and keeps going when one day is damaged", async () => {
    const other = "aaaaaaaa-0000-4000-8000-000000000001";
    const day = Date.UTC(2026, 9, 14);
    await fillDay(day, [0], Date.UTC(2026, 9, 14, 23, 59));
    const w2 = new CadenceWriter({ store, log, now: () => now });
    w2.add(other, [frame(day + 1000, 5)]);
    await w2.flushAll();
    store.files.set(`cadence/v1/${other}/2026/10/14/0000.csv.gz`, Buffer.from("garbage"));
    now = Date.UTC(2026, 9, 15, 3, 0, 0);
    const r = await mk(() => now).mergeFinishedDays(3);
    expect(r).toEqual({ merged: 1, failed: 1 });
    expect(warns).toContain("joining a day of cadence files failed");
  });
});
