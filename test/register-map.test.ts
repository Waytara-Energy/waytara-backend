import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MetricDef } from "../src/core/decode.js";
import { buildRegisterMap, isPolled } from "../src/core/register-map.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/catalogue.json", import.meta.url), "utf8")) as {
  stock: { mppt_count: number };
  sweepFail: number[];
  metrics: MetricDef[];
};
const failing = new Set(fx.sweepFail);
const catalogued = new Set(fx.metrics.filter((m) => m.direction === "read").flatMap((m) => m.registers));
const readable = (r: number) => catalogued.has(r) && !failing.has(r);

const def = (over: Partial<MetricDef>): MetricDef => ({ key: "k", direction: "read", registers: [10], decode: null, showForUser: true, cadenceSeconds: 30, ...over });

describe("what is polled", () => {
  it("never polls a calculated value, an action, or a hidden value", () => {
    expect(isPolled(def({ registers: [] }))).toBe(false);
    expect(isPolled(def({ direction: "command", registers: [] }))).toBe(false);
    expect(isPolled(def({ showForUser: false }))).toBe(false);
    expect(isPolled(def({ showForUser: true }))).toBe(true);
  });

  it("polls a hidden value once staff switch diagnostics on", () => {
    expect(isPolled(def({ showForUser: false, pollEnabled: true }))).toBe(true);
  });

  it("leaves out PV inputs the unit does not have", () => {
    expect(isPolled(def({ key: "pv3_power_w" }), 2)).toBe(false);
    expect(isPolled(def({ key: "pv2_power_w" }), 2)).toBe(true);
    expect(isPolled(def({ key: "pv2_power_w" }), 1)).toBe(false);
    expect(isPolled(def({ key: "pv3_power_w" }), undefined)).toBe(true);
    expect(isPolled(def({ key: "pv_total_power_w" }), 1)).toBe(true); // not a numbered input
  });
});

describe("the Waytara Office catalogue", () => {
  const map = buildRegisterMap(fx.metrics, { mpptCount: fx.stock.mppt_count, isReadable: readable });

  it("polls only customer-visible registers: 162 values on 161 registers", () => {
    expect(fx.stock.mppt_count).toBe(2);
    expect(map.metrics).toHaveLength(162);
    expect(map.registersPolled).toBe(161);
    const keys = new Set(map.metrics.map((m) => m.key));
    for (const calculated of ["pv_total_power_w", "savings_amount", "active_alerts", "clock_out_of_sync"]) expect(keys.has(calculated)).toBe(false);
    for (const m of map.metrics) expect(m.showForUser).toBe(true);
  });

  it("covers every polled register exactly once, at the cadence its most demanding value needs", () => {
    const need = new Map<number, number>();
    for (const m of map.metrics) for (const r of m.registers) need.set(r, Math.min(need.get(r) ?? Infinity, m.cadence));
    const seen = new Map<number, number>();
    for (const req of map.requests) {
      for (let r = req.start; r < req.start + req.count; r++) {
        if (need.has(r)) {
          expect(seen.has(r), `register ${r} requested twice`).toBe(false);
          seen.set(r, req.cadence);
        }
      }
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([...need.keys()].sort((a, b) => a - b));
    for (const [r, c] of need) expect(seen.get(r), `register ${r}`).toBe(c);
  });

  it("starts and ends every request on a register that is needed, and stays within the limits", () => {
    const needed = new Set(map.metrics.flatMap((m) => m.registers));
    for (const req of map.requests) {
      expect(needed.has(req.start)).toBe(true);
      expect(needed.has(req.start + req.count - 1)).toBe(true);
      expect(req.count).toBeLessThanOrEqual(60);
    }
  });

  it("only reads across a gap when every register in it is known to answer", () => {
    const needed = new Set(map.metrics.flatMap((m) => m.registers));
    for (const req of map.requests) {
      for (let r = req.start; r < req.start + req.count; r++) if (!needed.has(r)) expect(readable(r), `register ${r} is read but not known to answer`).toBe(true);
    }
  });

  it("is the same every time and changes when the catalogue changes", () => {
    const again = buildRegisterMap(fx.metrics, { mpptCount: 2, isReadable: readable });
    expect(again.hash).toBe(map.hash);
    const changed = fx.metrics.map((m) => (m.key === "battery_power_w" && m.direction === "read" ? { ...m, decode: { ...m.decode, scale: 10 } } : m));
    expect(buildRegisterMap(changed, { mpptCount: 2, isReadable: readable }).hash).not.toBe(map.hash);
    const diag = fx.metrics.map((m) => (m.key === "fault_history" ? { ...m, pollEnabled: true } : m));
    expect(buildRegisterMap(diag, { mpptCount: 2, isReadable: readable }).registersPolled).toBeGreaterThan(map.registersPolled);
  });

  it("lists the settings the board may change, with the bits and the raw limits", () => {
    const w = (k: string) => map.writes.find((x) => x.key === k)!;
    expect(w("time_of_use_monday_enabled")).toMatchObject({ register: 248, mask: 0x0002, minRaw: 0, maxRaw: 1, verified: false });
    expect(w("inverter_beep_enabled")).toMatchObject({ register: 330, mask: 0x000c, minRaw: 0, maxRaw: 3 });
    expect(w("battery_low_soc_pct")).toMatchObject({ register: 219, mask: 0xffff, minRaw: 0, maxRaw: 100, verified: true });
    expect(map.writes.some((x) => x.key === "inverter_date_time")).toBe(false); // three registers: a special command
    expect(map.writes.every((x) => x.mask > 0 && x.mask <= 0xffff)).toBe(true);
  });

  it("keeps the clock and the unverified settings visible in the list so the backend can block them", () => {
    expect(map.metrics.some((m) => m.key === "inverter_date_time" && m.direction === "write")).toBe(true);
    expect(map.metrics.filter((m) => !m.verified).length).toBeGreaterThan(0);
  });
});

describe("requests", () => {
  it("merges neighbours and splits at the span limit", () => {
    const defs = Array.from({ length: 10 }, (_, i) => def({ key: `k${i}`, registers: [100 + i], cadenceSeconds: 5 }));
    expect(buildRegisterMap(defs).requests).toEqual([{ start: 100, count: 10, cadence: 5 }]);
    expect(buildRegisterMap(defs, { maxSpan: 4 }).requests.map((r) => r.count)).toEqual([4, 4, 2]);
  });

  it("bridges a gap only over registers known to answer", () => {
    const defs = [def({ key: "a", registers: [10], cadenceSeconds: 5 }), def({ key: "b", registers: [13], cadenceSeconds: 5 })];
    expect(buildRegisterMap(defs).requests).toEqual([
      { start: 10, count: 1, cadence: 5 },
      { start: 13, count: 1, cadence: 5 },
    ]);
    expect(buildRegisterMap(defs, { isReadable: () => true }).requests).toEqual([{ start: 10, count: 4, cadence: 5 }]);
    expect(buildRegisterMap(defs, { isReadable: (r) => r !== 11 }).requests).toHaveLength(2);
    expect(buildRegisterMap(defs, { isReadable: () => true, maxGap: 1 }).requests).toHaveLength(2);
  });

  it("reads a register shared by a fast and a slow value at the fast rate", () => {
    const defs = [def({ key: "fast", registers: [93], cadenceSeconds: 10 }), def({ key: "slow", registers: [93], cadenceSeconds: 300 })];
    expect(buildRegisterMap(defs).requests).toEqual([{ start: 93, count: 1, cadence: 10 }]);
  });

  it("never mixes cadences in one request", () => {
    const defs = [def({ key: "a", registers: [10], cadenceSeconds: 5 }), def({ key: "b", registers: [11], cadenceSeconds: 300 })];
    expect(buildRegisterMap(defs, { isReadable: () => true }).requests).toEqual([
      { start: 10, count: 1, cadence: 5 },
      { start: 11, count: 1, cadence: 300 },
    ]);
  });

  it("uses the default cadence when the catalogue gives none", () => {
    const defs = [def({ key: "a", registers: [10], cadenceSeconds: null })];
    expect(buildRegisterMap(defs).requests).toEqual([{ start: 10, count: 1, cadence: 30 }]);
    expect(buildRegisterMap(defs, { defaultCadenceSeconds: 60 }).requests[0]!.cadence).toBe(60);
  });
});

describe("write limits", () => {
  it("turns a scaled, offset or signed range back into register units", () => {
    const scaled = def({ key: "s", direction: "write", decode: { scale: 0.1 }, validMin: 0, validMax: 100 });
    const offset = def({ key: "o", direction: "write", registers: [11], decode: { scale: 0.1, offset: -100 }, validMin: 0, validMax: 60 });
    const signed = def({ key: "g", direction: "write", registers: [12], decode: { signed: true }, validMin: -50, validMax: 50 });
    const unbounded = def({ key: "u", direction: "write", registers: [13] });
    const { writes } = buildRegisterMap([scaled, offset, signed, unbounded]);
    const get = (k: string) => writes.find((w) => w.key === k)!;
    expect(get("s")).toMatchObject({ minRaw: 0, maxRaw: 1000 });
    expect(get("o")).toMatchObject({ minRaw: 1000, maxRaw: 1600 });
    expect(get("g")).toMatchObject({ minRaw: 0xffce, maxRaw: 50 });
    expect(get("u")).toMatchObject({ minRaw: null, maxRaw: null });
  });

  it("does not list a PV input the unit lacks, even for a setting", () => {
    const d = def({ key: "pv3_max_power", direction: "write", registers: [50], showForUser: false });
    expect(buildRegisterMap([d], { mpptCount: 2 }).writes).toEqual([]);
    expect(buildRegisterMap([d]).writes).toHaveLength(1);
  });
});
