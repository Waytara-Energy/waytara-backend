import { describe, expect, it } from "vitest";
import type { MetricDef } from "../src/core/decode.js";
import type { WriteSlot } from "../src/core/register-map.js";
import { encodeSetting, formatSetting, parseSettingText, rawInBounds } from "../src/core/setting-value.js";

const def = (over: Partial<MetricDef>): MetricDef => ({ key: "k", direction: "write", registers: [200], decode: { scale: 1 }, showForUser: true, ...over });
const slot = (over: Partial<WriteSlot>): WriteSlot => ({ key: "k", register: 200, mask: 0xffff, minRaw: null, maxRaw: null, verified: true, ...over });

describe("parsing what a person or the log wrote", () => {
  it("accepts numbers and yes/no words, nothing else", () => {
    expect(parseSettingText("12")).toBe(12);
    expect(parseSettingText(" -3.5 ")).toBe(-3.5);
    expect(parseSettingText("true")).toBe(1);
    expect(parseSettingText("OFF")).toBe(0);
    expect(parseSettingText("")).toBeNull();
    expect(parseSettingText("12abc")).toBeNull();
    expect(parseSettingText("1e3")).toBeNull();
    expect(parseSettingText("NaN")).toBeNull();
  });
});

describe("encoding a setting for the register", () => {
  it("a plain whole register", () => {
    expect(encodeSetting(def({}), slot({}), "27")).toEqual({ ok: true, raw: 27 });
  });

  it("applies the scale: 0.1 steps", () => {
    const d = def({ decode: { scale: 0.1 } });
    expect(encodeSetting(d, slot({}), "27.5")).toEqual({ ok: true, raw: 275 });
    expect(encodeSetting(d, slot({}), "0.3")).toEqual({ ok: true, raw: 3 }); // 0.3 / 0.1 is 2.9999999999999996: rounded, not cut
  });

  it("applies the offset", () => {
    expect(encodeSetting(def({ decode: { scale: 0.1, offset: -100 } }), slot({}), "25")).toEqual({ ok: true, raw: 1250 });
  });

  it("writes a negative signed value as a two's complement word and reads it back", () => {
    const d = def({ decode: { scale: 1, signed: true } });
    expect(encodeSetting(d, slot({}), "-60")).toEqual({ ok: true, raw: 65476 });
    expect(formatSetting(d, slot({}), 65476)).toBe("-60");
    expect(encodeSetting(d, slot({}), "40000")).toMatchObject({ ok: false });
  });

  it("a bit field takes the field value, a yes/no is 1 or 0", () => {
    const s = slot({ register: 330, mask: 0x0004, minRaw: 0, maxRaw: 1 });
    const d = def({ registers: [330], decode: { bitmask: "0x0004" } });
    expect(encodeSetting(d, s, "true")).toEqual({ ok: true, raw: 1 });
    expect(encodeSetting(d, s, "0")).toEqual({ ok: true, raw: 0 });
    expect(encodeSetting(d, s, "2")).toMatchObject({ ok: false });
    expect(encodeSetting(d, s, "0.5")).toMatchObject({ ok: false });
    expect(formatSetting(d, s, 1)).toBe("1");
  });

  it("a wider bit field", () => {
    const s = slot({ mask: 0x0300, minRaw: 0, maxRaw: 3 });
    const d = def({ decode: { bitmask: "0x0300" } });
    expect(encodeSetting(d, s, "3")).toEqual({ ok: true, raw: 3 });
    expect(encodeSetting(d, s, "4")).toMatchObject({ ok: false });
  });

  it("refuses what is outside the catalogue's valid range, with the range in the message", () => {
    const d = def({ validMin: 10, validMax: 90 });
    expect(encodeSetting(d, slot({}), "50")).toMatchObject({ ok: true });
    const low = encodeSetting(d, slot({}), "9");
    expect(low).toMatchObject({ ok: false });
    expect((low as { reason: string }).reason).toContain("10 to 90");
    expect(encodeSetting(d, slot({}), "91")).toMatchObject({ ok: false });
  });

  it("refuses what is outside the raw bounds the board holds", () => {
    expect(encodeSetting(def({}), slot({ minRaw: 5, maxRaw: 20 }), "21")).toMatchObject({ ok: false });
    expect(encodeSetting(def({}), slot({ minRaw: 5, maxRaw: 20 }), "5")).toMatchObject({ ok: true });
  });

  it("refuses text that is not a value, without echoing a long string", () => {
    const r = encodeSetting(def({}), slot({}), "x".repeat(200));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason.length).toBeLessThan(100);
  });
});

describe("the allowed range of a signed setting that crosses zero", () => {
  it("is stored wrapped (low above high) and still judged correctly", () => {
    // -100..100 as two's complement words: 65436..65535 and 0..100
    expect(rawInBounds(65500, 65436, 100)).toBe(true);
    expect(rawInBounds(50, 65436, 100)).toBe(true);
    expect(rawInBounds(500, 65436, 100)).toBe(false);
    expect(rawInBounds(7, null, null)).toBe(true);
  });
});

describe("reading back", () => {
  it("formats a scaled value the way the log keeps it", () => {
    expect(formatSetting(def({ decode: { scale: 0.1 } }), slot({}), 275)).toBe("27.5");
    expect(formatSetting(def({ decode: { scale: 0.1, offset: -100 } }), slot({}), 1250)).toBe("25");
  });

  it("refuses a word that is not a register value", () => {
    expect(formatSetting(def({}), slot({}), 70000)).toBeNull();
    expect(formatSetting(def({}), slot({}), -1)).toBeNull();
  });

  it("what encodeSetting writes, formatSetting reads back unchanged", () => {
    for (const [d, text] of [
      [def({ decode: { scale: 0.1 } }), "27.5"],
      [def({ decode: { scale: 0.01 } }), "49.95"],
      [def({ decode: { scale: 1, signed: true } }), "-1500"],
      [def({ decode: { scale: 0.1, offset: -100 } }), "25.4"],
    ] as const) {
      const e = encodeSetting(d, slot({}), text);
      expect(e.ok).toBe(true);
      if (e.ok) expect(formatSetting(d, slot({}), e.raw)).toBe(text);
    }
  });
});
