/**
 * Turns the raw 16-bit words a board read from the inverter into values, using the rules stored in the catalogue
 * (waytara.equipment_metrics.decode). The board never decodes: it sends register numbers and raw words, and this module is the single
 * place where the formulas live. The rules are described in docs/DEYE_8K_REGISTER_DECODE.md of the dashboard repository.
 *
 *   scale / offset   value = raw x scale + offset            (temperatures: raw x 0.1 - 100)
 *   signed           raw is first turned into a two's complement number (16 bit, or 32 bit when two registers are combined)
 *   combine          two registers make one 32-bit number: low word + high word x 65536; low_word_register names the low one
 *   bitmask          a field inside one register: (raw & mask) >> trailing zero bits; scale and offset are not applied
 *   note             three registers need special reading: serial number (ASCII), HHMM times, and the packed inverter clock
 */

export interface DecodeRule {
  scale?: number;
  offset?: number;
  signed?: boolean;
  bitmask?: string;
  combine?: "low_high_word";
  low_word_register?: number;
  note?: string;
}

export interface MetricDef {
  key: string;
  direction: "read" | "write" | "command";
  registers: number[];
  decode: DecodeRule | null;
  enumRef?: string | null;
  /** number, bool, enum, text, timestamp... as in the template */
  valueKind?: string | null;
  validMin?: number | null;
  validMax?: number | null;
  cadenceSeconds?: number | null;
  showForUser: boolean;
  pollEnabled?: boolean;
  verified?: boolean;
}

/** The words of one reading, by register number. */
export type Words = ReadonlyMap<number, number> | Readonly<Record<number, number>>;

export type DecodeFailure = "no_register" | "missing_register" | "bad_word" | "unknown_rule" | "bad_value";

export type DecodeResult =
  | { ok: true; value: number | string; /** false when the value is outside valid_min..valid_max: keep it, but do not use it for summaries */ inRange: boolean }
  | { ok: false; reason: DecodeFailure };

function word(words: Words, reg: number): number | undefined {
  const w = words instanceof Map ? words.get(reg) : (words as Record<number, number>)[reg];
  return w;
}

const isWord = (w: number | undefined): w is number => typeof w === "number" && Number.isInteger(w) && w >= 0 && w <= 0xffff;

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function trailingShift(mask: number): number {
  let s = 0;
  while (s < 16 && ((mask >> s) & 1) === 0) s++;
  return s;
}

function checkRange(def: MetricDef, value: number | string): boolean {
  if (typeof value !== "number") return true;
  if (def.validMin != null && value < def.validMin) return false;
  if (def.validMax != null && value > def.validMax) return false;
  return true;
}

function decodeSpecial(def: MetricDef, words: Words, note: string): DecodeResult {
  const regs = def.registers;
  const ws: number[] = [];
  for (const r of regs) {
    const w = word(words, r);
    if (w === undefined) return { ok: false, reason: "missing_register" };
    if (!isWord(w)) return { ok: false, reason: "bad_word" };
    ws.push(w);
  }
  if (note.startsWith("ASCII:")) {
    let s = "";
    for (const w of ws) {
      for (const c of [w >> 8, w & 0xff]) if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c); // printable ASCII only
    }
    return { ok: true, value: s.trim(), inRange: true };
  }
  if (note.startsWith("HHMM decimal")) {
    const v = ws[0]!;
    const hour = Math.floor(v / 100);
    const minute = v % 100;
    return { ok: true, value: v, inRange: hour < 24 && minute < 60 };
  }
  if (note.startsWith("Packed bytes")) {
    if (ws.length !== 3) return { ok: false, reason: "unknown_rule" };
    const year = 2000 + (ws[0]! >> 8);
    const month = ws[0]! & 0xff;
    const day = ws[1]! >> 8;
    const hour = ws[1]! & 0xff;
    const minute = ws[2]! >> 8;
    const second = ws[2]! & 0xff;
    const valid = month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60 && second < 60;
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    // The inverter's own clock: local time, no zone.
    return { ok: true, value: `${p(year, 4)}-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:${p(second)}`, inRange: valid };
  }
  return { ok: false, reason: "unknown_rule" };
}

export function decodeMetric(def: MetricDef, words: Words): DecodeResult {
  if (def.registers.length === 0) return { ok: false, reason: "no_register" };
  const rule = def.decode ?? {};
  if (rule.note) return decodeSpecial(def, words, rule.note);

  const raws: number[] = [];
  for (const r of def.registers) {
    const w = word(words, r);
    if (w === undefined) return { ok: false, reason: "missing_register" };
    if (!isWord(w)) return { ok: false, reason: "bad_word" };
    raws.push(w);
  }

  if (rule.bitmask) {
    const mask = parseInt(rule.bitmask, 16);
    if (!Number.isFinite(mask) || mask <= 0 || mask > 0xffff) return { ok: false, reason: "unknown_rule" };
    const field = (raws[0]! & mask) >> trailingShift(mask);
    const value = def.valueKind === "bool" ? (field !== 0 ? 1 : 0) : field;
    return { ok: true, value, inRange: checkRange(def, value) };
  }

  let n: number;
  if (rule.combine) {
    if (rule.combine !== "low_high_word" || rule.low_word_register === undefined) return { ok: false, reason: "unknown_rule" };
    const lowIdx = def.registers.indexOf(rule.low_word_register);
    if (lowIdx < 0 || def.registers.length !== 2) return { ok: false, reason: "unknown_rule" };
    const lo = raws[lowIdx]!;
    const hi = raws[1 - lowIdx]!;
    n = lo + hi * 65536;
    if (rule.signed && n >= 0x80000000) n -= 0x100000000;
  } else if (raws.length === 1) {
    n = raws[0]!;
    if (rule.signed && n >= 0x8000) n -= 0x10000;
  } else {
    return { ok: false, reason: "unknown_rule" };
  }

  const scaled = n * (rule.scale ?? 1) + (rule.offset ?? 0);
  if (!Number.isFinite(scaled)) return { ok: false, reason: "bad_value" };
  const value = round(def.valueKind === "bool" ? (scaled !== 0 ? 1 : 0) : scaled);
  return { ok: true, value, inRange: checkRange(def, value) };
}

/** Decodes every metric whose registers are all present. Metrics that cannot be decoded are listed in `failed` with the reason. */
export function decodeAll(defs: readonly MetricDef[], words: Words): { values: Map<string, number | string>; outOfRange: string[]; failed: Map<string, DecodeFailure> } {
  const values = new Map<string, number | string>();
  const outOfRange: string[] = [];
  const failed = new Map<string, DecodeFailure>();
  for (const def of defs) {
    if (def.registers.length === 0) continue;
    const r = decodeMetric(def, words);
    if (!r.ok) {
      failed.set(def.key, r.reason);
      continue;
    }
    values.set(def.key, r.value);
    if (!r.inRange) outOfRange.push(def.key);
  }
  return { values, outOfRange, failed };
}

/**
 * The reverse, for writing a setting: the raw word to send for a value. The caller has already checked the range.
 * Bit fields are not handled here: they are written with a read-modify-write of only the masked bits (see register-map writes).
 */
export function encodeValue(def: MetricDef, value: number): number[] | null {
  const rule = def.decode ?? {};
  if (rule.note || rule.bitmask || def.registers.length !== 1 || rule.combine) return null;
  let raw = Math.round((value - (rule.offset ?? 0)) / (rule.scale ?? 1));
  if (rule.signed && raw < 0) raw += 0x10000;
  if (raw < 0 || raw > 0xffff) return null;
  return [raw];
}
