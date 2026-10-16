/**
 * Turns a setting the way a person or the settings log writes it ("1", "true", "27.5") into the raw register value a board writes, and a
 * value read back from the inverter into the text the log stores. The catalogue rule of the setting (scale, offset, signed, bit field)
 * decides both ways, so what is written and what is read back always use the same formula.
 *
 * The settings log keeps numbers as text: a yes/no setting is "1" or "0" (a person's "true" and "false" are accepted), a time is its
 * HHMM digits. Times, the inverter clock and other settings that need special reading (decode.note) are not written here.
 */
import { decodeMetric, type MetricDef } from "./decode.js";
import type { WriteSlot } from "./register-map.js";

export type Encoded = { ok: true; raw: number } | { ok: false; reason: string };

/** "1", "true", "on" ... and plain numbers; anything else is not a value. */
export function parseSettingText(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "true" || t === "on" || t === "yes") return 1;
  if (t === "false" || t === "off" || t === "no") return 0;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function shiftOf(mask: number): number {
  let s = 0;
  while (s < 16 && ((mask >> s) & 1) === 0) s++;
  return s;
}

/** Is `raw` inside the board's allowed range? A range that crosses zero for a signed setting is stored wrapped (low above high). */
export function rawInBounds(raw: number, lo: number | null, hi: number | null): boolean {
  if (lo === null && hi === null) return true;
  if (lo !== null && hi !== null && lo > hi) return raw >= lo || raw <= hi;
  if (lo !== null && raw < lo) return false;
  if (hi !== null && raw > hi) return false;
  return true;
}

/** The raw value for `text`: the field value for a bit-field setting, the whole 16-bit word otherwise. */
export function encodeSetting(def: MetricDef, slot: WriteSlot, text: string): Encoded {
  const v = parseSettingText(text);
  if (v === null) return { ok: false, reason: `"${text.slice(0, 40)}" is not a number or a yes/no value` };
  if ((def.validMin != null && v < def.validMin) || (def.validMax != null && v > def.validMax)) {
    return { ok: false, reason: `${v} is outside the allowed range (${def.validMin ?? "no minimum"} to ${def.validMax ?? "no maximum"})` };
  }
  const rule = def.decode ?? {};
  let raw: number;
  if (slot.mask !== 0xffff) {
    if (!Number.isInteger(v)) return { ok: false, reason: `${v} is not a whole number` };
    const fieldMax = slot.mask >> shiftOf(slot.mask);
    if (v < 0 || v > fieldMax) return { ok: false, reason: `${v} does not fit the setting (0 to ${fieldMax})` };
    raw = v;
  } else {
    const scale = rule.scale ?? 1;
    const offset = rule.offset ?? 0;
    raw = Math.round((v - offset) / scale);
    if (rule.signed) {
      if (raw < -32768 || raw > 32767) return { ok: false, reason: `${v} does not fit the register` };
      if (raw < 0) raw += 0x10000;
    }
    if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) return { ok: false, reason: `${v} does not fit the register` };
  }
  if (!rawInBounds(raw, slot.minRaw, slot.maxRaw)) return { ok: false, reason: `${v} is outside what the unit accepts for this setting` };
  return { ok: true, raw };
}

/** The log text of a value the board read back: `raw` is the field value for a bit field, the whole word otherwise. Null if it cannot be read. */
export function formatSetting(def: MetricDef, slot: WriteSlot, raw: number): string | null {
  if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) return null;
  if (slot.mask !== 0xffff) return String(raw);
  const r = decodeMetric({ ...def, registers: [slot.register], decode: def.decode ? { ...def.decode, bitmask: undefined } : null }, new Map([[slot.register, raw]]));
  if (!r.ok || typeof r.value !== "number") return null;
  return String(Math.round(r.value * 1e6) / 1e6);
}

/** The log text of a setting read as part of a normal data frame (decodeMetric already applied the rule). */
export function formatDecoded(value: number | string): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : null;
  return null;
}
