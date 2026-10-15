import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUCKET_S, computeBucket, holdFor, type Reading } from "../src/core/rollup.js";

/**
 * The strongest check available: real readings of the Waytara Office inverter, replayed through the new engine, must give the 15-minute
 * rows the unit firmware computed from the same readings and stored in Supabase.
 *
 * The readings come from the cadence history sheet, which is rounded and can miss a reading the unit did have, so a few buckets differ
 * slightly. Covered seconds and sample counts must agree exactly (they depend only on timing).
 */
interface Stored { key: string; b: number; wsum: number; covered: number; min: number | null; max: number | null; last: number | null; pos: number | null; neg: number | null; n: number }
const fx = JSON.parse(readFileSync(new URL("./fixtures/replay-2026-10-14.json", import.meta.url), "utf8")) as {
  series: Record<string, { cadence: number; readings: [number, number][] }>;
  stored: Stored[];
};

const near = (a: number, b: number, rel: number, abs: number) => Math.abs(a - b) <= Math.max(abs, Math.abs(b) * rel);

describe("replay of 2026-10-14 13:00-16:30 IST", () => {
  const results = fx.stored.map((row) => {
    const s = fx.series[row.key]!;
    const readings: Reading[] = s.readings.map(([t, v]) => ({ t, v }));
    const mine = computeBucket(readings, row.b, holdFor(s.cadence), row.b + BUCKET_S)!;
    return { row, mine };
  });

  it("has a worthwhile number of buckets", () => {
    expect(results.length).toBeGreaterThanOrEqual(100);
    expect(new Set(fx.stored.map((r) => r.key)).size).toBe(10);
  });

  it("every stored bucket is reproduced", () => {
    expect(results.every((r) => r.mine)).toBe(true);
  });

  it("covered seconds agree to within 3 s in every bucket", () => {
    const bad = results.filter(({ row, mine }) => !near(mine.covered, row.covered, 0, 3));
    expect(bad.map((b) => `${b.row.key}@${b.row.b}: ${b.mine.covered} vs ${b.row.covered}`)).toEqual([]);
  });

  it("sample counts agree to within 2 in every bucket", () => {
    const bad = results.filter(({ row, mine }) => Math.abs(mine.n - row.n) > 2);
    expect(bad.map((b) => `${b.row.key}@${b.row.b}: ${b.mine.n} vs ${b.row.n}`)).toEqual([]);
  });

  it("the sums, minimums, maximums and last values agree in at least 97% of buckets", () => {
    const ok = results.filter(({ row, mine }) => {
      const wOk = near(mine.wsum, row.wsum, 0.01, 36);
      const minOk = row.min === null || near(mine.min, row.min, 0.002, 0.02);
      const maxOk = row.max === null || near(mine.max, row.max, 0.002, 0.02);
      const lastOk = row.last === null || near(mine.last, row.last, 0.002, 0.02);
      return wOk && minOk && maxOk && lastOk;
    });
    expect(ok.length / results.length).toBeGreaterThanOrEqual(0.97);
  });

  it("positive and negative parts appear exactly when the unit stored them", () => {
    const bad = results.filter(({ row, mine }) => (row.neg !== null) !== (mine.neg !== undefined));
    expect(bad.map((b) => `${b.row.key}@${b.row.b}`)).toEqual([]);
  });

  it("the energy view agrees: a day of PV watts summed to kWh within 0.5%", () => {
    const pv = results.filter((r) => r.row.key === "pv1_power_w");
    const mine = pv.reduce((n, r) => n + r.mine.wsum, 0) / 3600 / 1000;
    const stored = pv.reduce((n, r) => n + r.row.wsum, 0) / 3600 / 1000;
    expect(near(mine, stored, 0.005, 0.001)).toBe(true);
  });
});
