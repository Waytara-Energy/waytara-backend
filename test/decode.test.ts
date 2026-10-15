import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeAll, decodeMetric, encodeValue, type MetricDef } from "../src/core/decode.js";

const catalogue = JSON.parse(readFileSync(new URL("./fixtures/catalogue.json", import.meta.url), "utf8")) as { metrics: MetricDef[] };
const vectors = JSON.parse(readFileSync(new URL("../test-vectors/decode.json", import.meta.url), "utf8")) as {
  vectors: { key: string; registers: number[]; raw: number[]; expected: number; source: string }[];
};
const byKey = new Map(catalogue.metrics.filter((m) => m.registers.length > 0).map((m) => [`${m.direction}:${m.key}`, m]));
const readDef = (key: string) => {
  const d = byKey.get(`read:${key}`) ?? byKey.get(`write:${key}`);
  if (!d) throw new Error(`no metric ${key}`);
  return d;
};
const words = (regs: number[], vals: number[]) => new Map(regs.map((r, i) => [r, vals[i]!]));

describe("the catalogue rules, checked against the 10 Sep register sweep", () => {
  it("has the vectors", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(54);
  });
  for (const v of vectors.vectors) {
    it(`${v.key} (register ${v.registers.join("+")}, raw ${v.raw.join(",")}) = ${v.expected}`, () => {
      const d = readDef(v.key);
      const r = decodeMetric(d, words(v.registers, v.raw));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBeCloseTo(v.expected, 3);
    });
  }
});

describe("decode rules", () => {
  const base = (over: Partial<MetricDef>): MetricDef => ({ key: "x", direction: "read", registers: [10], decode: null, showForUser: true, ...over });

  it("applies scale and offset", () => {
    expect(decodeMetric(base({ decode: { scale: 0.1, offset: -100 } }), words([10], [1504]))).toMatchObject({ ok: true, value: 50.4 });
  });

  it("reads a negative number from a signed register", () => {
    expect(decodeMetric(base({ decode: { signed: true } }), words([10], [65476]))).toMatchObject({ ok: true, value: -60 });
    expect(decodeMetric(base({ decode: { signed: true, scale: 0.01 } }), words([10], [65535]))).toMatchObject({ ok: true, value: -0.01 });
    expect(decodeMetric(base({ decode: {} }), words([10], [65476]))).toMatchObject({ ok: true, value: 65476 });
  });

  it("combines two registers into a 32-bit counter, low word named by the rule", () => {
    const d = base({ registers: [78, 80], decode: { combine: "low_high_word", low_word_register: 78, scale: 0.1 } });
    expect(decodeMetric(d, words([78, 80], [1000, 2]))).toMatchObject({ ok: true, value: (1000 + 2 * 65536) * 0.1 });
    const swapped = base({ registers: [78, 80], decode: { combine: "low_high_word", low_word_register: 80, scale: 1 } });
    expect(decodeMetric(swapped, words([78, 80], [1000, 2]))).toMatchObject({ ok: true, value: 2 + 1000 * 65536 });
  });

  it("reads a field inside a register and a yes/no flag", () => {
    const field = base({ registers: [248], decode: { bitmask: "0x0006" } });
    expect(decodeMetric(field, words([248], [0b110]))).toMatchObject({ ok: true, value: 3 });
    const flag = base({ registers: [248], valueKind: "bool", decode: { bitmask: "0x0002" } });
    expect(decodeMetric(flag, words([248], [0b10]))).toMatchObject({ ok: true, value: 1 });
    expect(decodeMetric(flag, words([248], [0b01]))).toMatchObject({ ok: true, value: 0 });
  });

  it("reads the serial number (ASCII, high byte first)", () => {
    const d = base({ registers: [3, 4, 5, 6, 7], decode: { note: "ASCII: 10 characters packed 2 per register (high byte first) across regs 3-7." } });
    const w = [..."2405281234"].reduce<number[]>((acc, c, i) => (i % 2 === 0 ? [...acc, c.charCodeAt(0) << 8] : [...acc.slice(0, -1), acc[acc.length - 1]! | c.charCodeAt(0)]), []);
    expect(decodeMetric(d, words([3, 4, 5, 6, 7], w))).toMatchObject({ ok: true, value: "2405281234" });
  });

  it("reads a time of day written as HHMM and flags an impossible one", () => {
    const d = base({ decode: { note: "HHMM decimal: value 2359 = 23:59 (hour = v div 100, minute = v mod 100)." } });
    expect(decodeMetric(d, words([10], [2359]))).toMatchObject({ ok: true, value: 2359, inRange: true });
    expect(decodeMetric(d, words([10], [2575]))).toMatchObject({ ok: true, inRange: false });
  });

  it("reads the inverter clock", () => {
    const d = base({ registers: [22, 23, 24], decode: { note: "Packed bytes, 2 per register, high byte first: reg 22 = year-2000 / month, reg 23 = day / hour, reg 24 = minute / second." } });
    const r = decodeMetric(d, words([22, 23, 24], [(26 << 8) | 10, (15 << 8) | 11, (49 << 8) | 7]));
    expect(r).toMatchObject({ ok: true, value: "2026-10-15T11:49:07", inRange: true });
    expect(decodeMetric(d, words([22, 23, 24], [(26 << 8) | 13, 0, 0]))).toMatchObject({ ok: true, inRange: false });
  });

  it("keeps an out-of-range value but marks it", () => {
    const d = base({ decode: { scale: 1 }, validMin: 0, validMax: 100 });
    expect(decodeMetric(d, words([10], [150]))).toMatchObject({ ok: true, value: 150, inRange: false });
    expect(decodeMetric(d, words([10], [50]))).toMatchObject({ ok: true, value: 50, inRange: true });
  });

  it("says why it cannot decode", () => {
    expect(decodeMetric(base({ registers: [] }), words([], []))).toEqual({ ok: false, reason: "no_register" });
    expect(decodeMetric(base({}), new Map())).toEqual({ ok: false, reason: "missing_register" });
    expect(decodeMetric(base({}), words([10], [70000]))).toEqual({ ok: false, reason: "bad_word" });
    expect(decodeMetric(base({ decode: { bitmask: "zz" } }), words([10], [1]))).toEqual({ ok: false, reason: "unknown_rule" });
    expect(decodeMetric(base({ decode: { note: "something new" } }), words([10], [1]))).toEqual({ ok: false, reason: "unknown_rule" });
  });

  it("accepts plain objects as well as maps", () => {
    expect(decodeMetric(base({ decode: { scale: 2 } }), { 10: 21 })).toMatchObject({ ok: true, value: 42 });
  });
});

describe("every rule in the live catalogue is understood", () => {
  it("decodes every register-backed metric when all its words are present", () => {
    const failures: string[] = [];
    for (const d of catalogue.metrics) {
      if (d.registers.length === 0) continue;
      const w = new Map(d.registers.map((r) => [r, 0]));
      // a date needs a month and day of 1 to be valid; the serial number needs no valid bytes
      if (d.key === "inverter_date_time") {
        w.set(22, 26 << 8 | 1);
        w.set(23, 1 << 8);
      }
      const r = decodeMetric(d, w);
      if (!r.ok) failures.push(`${d.direction}:${d.key} -> ${r.reason}`);
    }
    expect(failures).toEqual([]);
  });

  it("decodeAll skips calculated values and reports failures by name", () => {
    const some = catalogue.metrics.filter((m) => ["battery_power_w", "pv_total_power_w", "grid_total_power_w"].includes(m.key));
    const { values, failed } = decodeAll(some, new Map([[190, 65476]]));
    expect(values.get("battery_power_w")).toBe(-60);
    expect(values.has("pv_total_power_w")).toBe(false);
    expect(failed.get("grid_total_power_w")).toBe("missing_register");
  });
});

describe("encodeValue (the way back for a setting)", () => {
  it("is the inverse of decode for scaled and signed values", () => {
    const scaled: MetricDef = { key: "s", direction: "write", registers: [1], decode: { scale: 0.1 }, showForUser: true };
    expect(encodeValue(scaled, 52.4)).toEqual([524]);
    const signed: MetricDef = { key: "s", direction: "write", registers: [1], decode: { signed: true }, showForUser: true };
    expect(encodeValue(signed, -60)).toEqual([65476]);
    const offset: MetricDef = { key: "s", direction: "write", registers: [1], decode: { scale: 0.1, offset: -100 }, showForUser: true };
    expect(encodeValue(offset, 50.4)).toEqual([1504]);
  });

  it("refuses what it cannot encode safely", () => {
    expect(encodeValue({ key: "b", direction: "write", registers: [1], decode: { bitmask: "0x0002" }, showForUser: true }, 1)).toBeNull();
    expect(encodeValue({ key: "m", direction: "write", registers: [1, 2], decode: null, showForUser: true }, 1)).toBeNull();
    expect(encodeValue({ key: "r", direction: "write", registers: [1], decode: null, showForUser: true }, 70000)).toBeNull();
  });
});
