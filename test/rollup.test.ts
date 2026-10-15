import { describe, expect, it } from "vitest";
import { BUCKET_S, RollupEngine, bucketStartOf, computeBucket, holdFor, type Reading } from "../src/core/rollup.js";

const S = 1_792_044_000; // a quarter-hour boundary (divisible by 900)
const E = S + BUCKET_S;
const rd = (t: number, v: number): Reading => ({ t, v });

describe("holdFor", () => {
  it("is twice the cadence, at least 60 s and at most 2 h", () => {
    expect(holdFor(5)).toBe(60);
    expect(holdFor(10)).toBe(60);
    expect(holdFor(30)).toBe(60);
    expect(holdFor(300)).toBe(600);
    expect(holdFor(3600)).toBe(7200);
    expect(holdFor(99999)).toBe(7200);
    expect(holdFor(null)).toBe(60);
    expect(holdFor(0)).toBe(60);
  });
  it("starts buckets on the quarter hour", () => {
    expect(S % 900).toBe(0);
    expect(bucketStartOf(S + 899.9)).toBe(S);
    expect(bucketStartOf(E)).toBe(E);
  });
});

describe("computeBucket (sample and hold)", () => {
  it("holds one reading for the hold time, no longer", () => {
    const b = computeBucket([rd(S + 10, 100)], S, 60, E)!;
    expect(b).toMatchObject({ wsum: 6000, covered: 60, min: 100, max: 100, last: 100, n: 1 });
    expect(b.pos).toBeUndefined();
  });

  it("holds a reading only until the next one", () => {
    const b = computeBucket([rd(S, 10), rd(S + 5, 20), rd(S + 10, 30)], S, 60, S + 12)!;
    // 10 for 5 s, 20 for 5 s, 30 for 2 s (the limit is `now`)
    expect(b.wsum).toBe(10 * 5 + 20 * 5 + 30 * 2);
    expect(b.covered).toBe(12);
    expect(b).toMatchObject({ min: 10, max: 30, last: 30, n: 3 });
  });

  it("does not cover a gap with no readings", () => {
    const b = computeBucket([rd(S, 100), rd(S + 300, 100)], S, 60, E)!;
    expect(b.covered).toBe(60 + 60);
    expect(b.wsum).toBe(100 * 120);
  });

  it("cuts a held stretch at the bucket edges", () => {
    const readings = [rd(E - 30, 200)];
    const first = computeBucket(readings, S, 60, E)!;
    expect(first).toMatchObject({ covered: 30, wsum: 6000, n: 1 });
    const second = computeBucket(readings, E, 60, E + 100)!;
    // the carry-over: 30 s of the previous reading, no reading of its own in this bucket
    expect(second).toMatchObject({ covered: 30, wsum: 6000, n: 0, min: 200, max: 200, last: 200 });
  });

  it("keeps positive and negative parts only when a value is negative", () => {
    const b = computeBucket([rd(S, 100), rd(S + 10, -50), rd(S + 20, 0)], S, 60, S + 30)!;
    expect(b.min).toBe(-50);
    expect(b.pos).toBe(100 * 10);
    expect(b.neg).toBe(50 * 10);
    expect(b.wsum).toBe(100 * 10 - 50 * 10);
  });

  it("takes `last` from the newest reading", () => {
    const b = computeBucket([rd(S, 1), rd(S + 5, 2), rd(S + 10, 3)], S, 60, E)!;
    expect(b.last).toBe(3);
  });

  it("returns nothing for an empty bucket", () => {
    expect(computeBucket([rd(S - 5000, 1)], S, 60, E)).toBeNull();
    expect(computeBucket([], S, 60, E)).toBeNull();
  });

  it("a longer cadence holds longer", () => {
    const b = computeBucket([rd(S, 7)], S, holdFor(300), E)!;
    expect(b.covered).toBe(600);
    expect(b.wsum).toBe(4200);
  });
});

describe("RollupEngine", () => {
  const feed = (e: RollupEngine, key: string, from: number, to: number, step: number, v: (t: number) => number) => {
    for (let t = from; t < to; t += step) e.add(key, t, v(t), 5);
  };

  it("hands out a finished bucket once, and not before it is finished", () => {
    const e = new RollupEngine();
    feed(e, "pv", S, S + 900, 5, () => 100);
    expect(e.collectClosed(S + 600)).toEqual([]);
    const done = e.collectClosed(E + 3);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ key: "pv", start: S, covered: 900, wsum: 90_000, n: 180 });
    expect(e.collectClosed(E + 10)).toEqual([]);
  });

  it("makes a whole day of 5 s readings add up", () => {
    const e = new RollupEngine();
    feed(e, "load", S, S + 4 * 900, 5, (t) => 500 + (t % 7));
    const closed = e.collectClosed(S + 4 * 900 + 1);
    expect(closed.map((b) => b.start)).toEqual([S, S + 900, S + 1800, S + 2700]);
    expect(closed.every((b) => b.covered === 900)).toBe(true);
  });

  it("hands a bucket out again, in full, when a late reading arrives", () => {
    const e = new RollupEngine();
    feed(e, "pv", S, S + 900, 5, () => 100);
    // the hole 10:00:30..10:00:55 was never received
    const first = e.collectClosed(E + 1)[0]!;
    expect(first.covered).toBe(900);
    // a reading from inside the bucket arrives late, with a different value
    e.add("pv", S + 100, 999, 5);
    const again = e.collectClosed(E + 20);
    expect(again).toHaveLength(1);
    expect(again[0]!.start).toBe(S);
    expect(again[0]!.max).toBe(999);
    expect(again[0]!.n).toBe(first.n + 1);
    expect(again[0]!.wsum).toBeGreaterThan(first.wsum);
  });

  it("ignores an exact repeat of a reading", () => {
    const e = new RollupEngine();
    e.add("pv", S, 1, 5);
    e.add("pv", S, 1, 5);
    e.add("pv", S, 1, 5);
    expect(e.size().readings).toBe(1);
  });

  it("accepts readings out of order and gives the same answer as in order", () => {
    const a = new RollupEngine();
    const b = new RollupEngine();
    const rs = Array.from({ length: 60 }, (_, i) => rd(S + i * 5, (i * 37) % 11));
    for (const r of rs) a.add("k", r.t, r.v, 5);
    for (const r of [...rs].reverse()) b.add("k", r.t, r.v, 5);
    expect(b.collectClosed(E + 1)).toEqual(a.collectClosed(E + 1));
  });

  it("shows the unfinished bucket as it stands", () => {
    const e = new RollupEngine();
    feed(e, "pv", S, S + 100, 5, () => 10);
    const open = e.open("pv", S + 100)!;
    expect(open.covered).toBe(100);
    expect(open.wsum).toBe(1000);
    expect(e.open("none", S)).toBeNull();
  });

  it("lists the unfinished bucket of every value that has readings", () => {
    const e = new RollupEngine();
    feed(e, "pv", S, S + 100, 5, () => 10);
    feed(e, "soc", S, S + 100, 5, () => 80);
    const all = e.openAll(S + 100);
    expect(all.map((o) => o.key).sort()).toEqual(["pv", "soc"]);
    expect(all.find((o) => o.key === "soc")!.bucket).toMatchObject({ start: S, covered: 100, wsum: 8000 });
    expect(new RollupEngine().openAll(S)).toEqual([]);
  });

  it("carries a reading's hold across the boundary into the next bucket", () => {
    const e = new RollupEngine();
    e.add("pv", E - 20, 50, 5);
    const closed = e.collectClosed(E + 1);
    expect(closed[0]).toMatchObject({ covered: 20, wsum: 1000 });
    const open = e.open("pv", E + 30)!;
    expect(open).toMatchObject({ covered: 30, wsum: 1500, n: 0 });
  });

  it("forgets old readings but keeps the one whose hold may still matter", () => {
    const e = new RollupEngine({ retainSeconds: 3600 });
    feed(e, "pv", S, S + 6 * 3600, 5, () => 1);
    e.collectClosed(S + 6 * 3600);
    expect(e.size().readings).toBeLessThan(3600 / 5 + 400);
    expect(e.size().readings).toBeGreaterThan(3000 / 5);
  });

  it("ignores readings that are not numbers", () => {
    const e = new RollupEngine();
    e.add("pv", S, Number.NaN, 5);
    e.add("pv", Number.POSITIVE_INFINITY, 1, 5);
    expect(e.size().readings).toBe(0);
  });
});
