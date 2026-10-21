import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMetric, isHhmmRule, type MetricDef } from "../src/core/decode.js";
import { buildRegisterMap, type WriteSlot } from "../src/core/register-map.js";
import { encodeSetting, formatSetting, rawInBounds } from "../src/core/setting-value.js";

// The writable settings of the office inverter, exported from the live catalogue (63 of them): every one must either go through the codec
// both ways with no loss, or be listed here as deliberately not writable by a single-register command.
const catalogue = JSON.parse(readFileSync(new URL("./fixtures/write-catalogue.json", import.meta.url), "utf8")) as MetricDef[];
const defs: MetricDef[] = catalogue.map((d) => ({ ...d, direction: "write" as const }));
const map = buildRegisterMap(defs);
const slotOf = new Map<string, WriteSlot>(map.writes.map((w) => [w.key, w]));
const defOf = new Map(defs.map((d) => [d.key, d]));

/** Not written with a single-register command: the inverter's clock is three packed registers (a separate command, not built). */
const NOT_SINGLE_REGISTER = new Set(["inverter_date_time"]);

/** Raw field values worth trying for one setting: both ends of what the unit accepts, and a value in between. */
function samples(def: MetricDef, slot: WriteSlot): number[] {
  const lo = slot.minRaw ?? 0;
  const hi = slot.maxRaw ?? lo + 100;
  const out = new Set<number>();
  const push = (raw: number) => {
    if (rawInBounds(raw, slot.minRaw, slot.maxRaw)) out.add(raw);
  };
  if (isHhmmRule(def.decode)) {
    for (const t of [0, 100, 900, 1230, 1730, 2359]) push(t);
    return [...out];
  }
  push(lo);
  push(hi);
  push(Math.floor((lo + hi) / 2));
  return [...out];
}

describe("every writable setting of the catalogue", () => {
  it("is either in the board's allow-list or deliberately not writable", () => {
    const missing = defs.filter((d) => !slotOf.has(d.key) && !NOT_SINGLE_REGISTER.has(d.key)).map((d) => d.key);
    expect(missing).toEqual([]);
    expect(map.writes.length).toBe(defs.length - NOT_SINGLE_REGISTER.size);
  });

  it("keeps the six times of day in the allow-list as whole-register writes from 0000 to 2359", () => {
    const times = defs.filter((d) => isHhmmRule(d.decode));
    expect(times.length).toBe(6);
    for (const d of times) expect(slotOf.get(d.key)).toMatchObject({ mask: 0xffff, minRaw: 0, maxRaw: 2359 });
  });

  it("gives the same value back after a write: raw to text to raw, for the ends and the middle of its range", () => {
    let checked = 0;
    for (const slot of map.writes) {
      const def = defOf.get(slot.key)!;
      for (const raw of samples(def, slot)) {
        const text = formatSetting(def, slot, raw);
        expect(text, `${slot.key}: raw ${raw} can be turned into the log's text`).not.toBeNull();
        const encoded = encodeSetting(def, slot, text!);
        expect(encoded, `${slot.key}: "${text}" can be encoded again`).toEqual({ ok: true, raw });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("decodes what it wrote the same way a normal reading would", () => {
    for (const slot of map.writes) {
      const def = defOf.get(slot.key)!;
      if (slot.mask !== 0xffff) continue; // a bit field is checked through the field value above
      for (const raw of samples(def, slot)) {
        const read = decodeMetric(def, new Map([[slot.register, raw]]));
        const text = formatSetting(def, slot, raw);
        expect(read.ok, slot.key).toBe(true);
        if (read.ok && typeof read.value === "number") expect(String(Math.round(read.value * 1e6) / 1e6), slot.key).toBe(text);
      }
    }
  });

  it("refuses a value outside what the unit accepts, and a value that is not a number", () => {
    for (const slot of map.writes) {
      const def = defOf.get(slot.key)!;
      expect(encodeSetting(def, slot, "not a number").ok, `${slot.key}: text`).toBe(false);
      if (slot.maxRaw !== null && slot.mask === 0xffff && !isHhmmRule(def.decode) && (def.decode?.scale ?? 1) === 1 && !def.decode?.offset && !def.decode?.signed) {
        expect(encodeSetting(def, slot, String(slot.maxRaw + 1)).ok, `${slot.key}: above the top`).toBe(false);
      }
    }
  });
});

describe("a time of day", () => {
  const key = "time_of_use_slot3_start_time";
  const def = defOf.get(key)!;
  const slot = slotOf.get(key)!;

  it("is written as its HHMM digits", () => {
    expect(encodeSetting(def, slot, "900")).toEqual({ ok: true, raw: 900 });
    expect(encodeSetting(def, slot, "1730")).toEqual({ ok: true, raw: 1730 });
    expect(encodeSetting(def, slot, "0")).toEqual({ ok: true, raw: 0 });
    expect(encodeSetting(def, slot, "2359")).toEqual({ ok: true, raw: 2359 });
  });

  it("refuses what is not a time: 60 minutes, hour 24, a fraction, a negative", () => {
    for (const bad of ["960", "2400", "2575", "905.5", "-100", "99999"]) {
      const r = encodeSetting(def, slot, bad);
      expect(r.ok, bad).toBe(false);
    }
    const reason = encodeSetting(def, slot, "960");
    expect(reason.ok === false && reason.reason).toMatch(/not a time of day/);
  });

  it("is read back as the same digits", () => {
    expect(formatSetting(def, slot, 900)).toBe("900");
    expect(formatSetting(def, slot, 1730)).toBe("1730");
  });
});

describe("yes/no settings", () => {
  it("take yes, on, true, 1 and no, off, false, 0 and write 1 or 0 into their bit", () => {
    const key = "time_of_use_slot3_grid_charge_enabled";
    const def = defOf.get(key)!;
    const slot = slotOf.get(key)!;
    for (const t of ["true", "on", "yes", "1"]) expect(encodeSetting(def, slot, t)).toEqual({ ok: true, raw: 1 });
    for (const t of ["false", "off", "no", "0"]) expect(encodeSetting(def, slot, t)).toEqual({ ok: true, raw: 0 });
    expect(encodeSetting(def, slot, "2").ok).toBe(false);
  });
});
