/**
 * Builds the register map a board polls from the catalogue (plan sections 5.2, 5.3 and 10.5).
 *
 * What is polled: every read or write register that customers see (show_for_user) or that staff switched on for diagnostics (poll_enabled).
 * Calculated values have no register and are never polled. The number of PV inputs comes from the stock record (mppt_count) so a
 * two-input inverter never asks for a third input's registers.
 *
 * The board receives `requests` (what to read and how often) and `writes` (the only registers it may change). The backend keeps
 * `metrics` to decode what comes back.
 */
import { createHash } from "node:crypto";
import type { DecodeRule, MetricDef } from "./decode.js";

export interface MapOptions {
  /** PV inputs the unit has (stock record technical_specs.mppt_count); pvN_* keys with N above it are left out */
  mpptCount?: number;
  /** merge two needed registers into one request when at most this many other registers lie between them (default 3) */
  maxGap?: number;
  /** longest single request in registers (default 60; the real limit of the inverter is a spike, 125 is the Modbus maximum) */
  maxSpan?: number;
  /** true if the register is known to answer; gaps are only bridged over readable registers (default: no gap is bridged) */
  isReadable?: (register: number) => boolean;
  /** cadence used when the catalogue gives none (default 30 s) */
  defaultCadenceSeconds?: number;
}

export interface RegisterRequest {
  start: number;
  count: number;
  /** seconds between reads */
  cadence: number;
}

export interface WriteSlot {
  key: string;
  register: number;
  /** only these bits are changed (read-modify-write); 0xFFFF for a whole register */
  mask: number;
  /** allowed raw value range after the mask is applied (shifted down) */
  minRaw: number | null;
  maxRaw: number | null;
  verified: boolean;
}

export interface MapMetric {
  key: string;
  direction: "read" | "write";
  registers: number[];
  decode: DecodeRule | null;
  enumRef: string | null;
  valueKind: string | null;
  validMin: number | null;
  validMax: number | null;
  cadence: number;
  showForUser: boolean;
  verified: boolean;
}

export interface RegisterMap {
  /** sha256 of the content: the same catalogue always gives the same hash, a changed one gives a new hash */
  hash: string;
  requests: RegisterRequest[];
  writes: WriteSlot[];
  metrics: MapMetric[];
  registersPolled: number;
  registersRequested: number;
}

const PV_KEY = /^pv(\d+)_/;

export function isPolled(def: MetricDef, mpptCount?: number): boolean {
  if (def.direction === "command") return false;
  if (def.registers.length === 0) return false;
  if (!def.showForUser && !def.pollEnabled) return false;
  if (mpptCount !== undefined) {
    const m = PV_KEY.exec(def.key);
    if (m && Number(m[1]) > mpptCount) return false;
  }
  return true;
}

function maskOf(def: MetricDef): number {
  const rule = def.decode;
  if (rule?.bitmask) return parseInt(rule.bitmask, 16);
  return 0xffff;
}

function shiftOf(mask: number): number {
  let s = 0;
  while (s < 16 && ((mask >> s) & 1) === 0) s++;
  return s;
}

/** Raw bounds for a write: the valid range turned back into register units. */
function rawBounds(def: MetricDef, mask: number): { minRaw: number | null; maxRaw: number | null } {
  const rule = def.decode ?? {};
  if (rule.bitmask) {
    const fieldMax = mask >> shiftOf(mask);
    return { minRaw: 0, maxRaw: fieldMax };
  }
  const scale = rule.scale ?? 1;
  const offset = rule.offset ?? 0;
  const toRaw = (v: number | null | undefined) => (v == null ? null : Math.round((v - offset) / scale));
  let lo = toRaw(def.validMin);
  let hi = toRaw(def.validMax);
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  if (rule.signed) {
    // signed values are written as two's complement words
    if (lo !== null && lo < 0) lo += 0x10000;
    if (hi !== null && hi < 0) hi += 0x10000;
  }
  return { minRaw: lo, maxRaw: hi };
}

export function buildRegisterMap(defs: readonly MetricDef[], options: MapOptions = {}): RegisterMap {
  const maxGap = options.maxGap ?? 3;
  const maxSpan = options.maxSpan ?? 60;
  const dflt = options.defaultCadenceSeconds ?? 30;
  const isReadable = options.isReadable ?? (() => false);

  const polled = defs.filter((d) => isPolled(d, options.mpptCount));

  const metrics: MapMetric[] = polled
    .map((d) => ({
      key: d.key,
      direction: d.direction as "read" | "write",
      registers: [...d.registers],
      decode: d.decode ?? null,
      enumRef: d.enumRef ?? null,
      valueKind: d.valueKind ?? null,
      validMin: d.validMin ?? null,
      validMax: d.validMax ?? null,
      cadence: d.cadenceSeconds && d.cadenceSeconds > 0 ? d.cadenceSeconds : dflt,
      showForUser: d.showForUser,
      verified: d.verified ?? false,
    }))
    .sort((a, b) => (a.registers[0]! - b.registers[0]!) || a.key.localeCompare(b.key) || a.direction.localeCompare(b.direction));

  // each register is read as often as its most demanding value needs
  const cadenceOf = new Map<number, number>();
  for (const m of metrics) for (const r of m.registers) cadenceOf.set(r, Math.min(cadenceOf.get(r) ?? Infinity, m.cadence));

  const byCadence = new Map<number, number[]>();
  for (const [reg, cad] of cadenceOf) {
    const list = byCadence.get(cad) ?? [];
    list.push(reg);
    byCadence.set(cad, list);
  }

  const requests: RegisterRequest[] = [];
  for (const [cadence, regs] of [...byCadence.entries()].sort((a, b) => a[0] - b[0])) {
    regs.sort((a, b) => a - b);
    let start = regs[0]!;
    let prev = regs[0]!;
    const flush = () => requests.push({ start, count: prev - start + 1, cadence });
    for (const reg of regs.slice(1)) {
      const gap = reg - prev - 1;
      let bridge = gap <= maxGap;
      // only bridge over registers that answer and that no other request reads (reading one twice at two rates only wastes bus time)
      if (bridge) for (let g = prev + 1; g < reg; g++) if (!isReadable(g) || cadenceOf.has(g)) bridge = false;
      const span = reg - start + 1;
      if (bridge && span <= maxSpan) {
        prev = reg;
      } else {
        flush();
        start = reg;
        prev = reg;
      }
    }
    flush();
  }
  requests.sort((a, b) => a.cadence - b.cadence || a.start - b.start);

  // The allow-list of writable registers: single-register settings only (the clock and other multi-register writes are special commands).
  // It covers every setting the catalogue defines for this unit, shown to the customer or not: WHO may change which one is decided by
  // the backend (role, verified flag) before it signs a command; the board only refuses what is not on this list.
  const writes: WriteSlot[] = [];
  for (const d of defs) {
    if (d.direction !== "write" || d.registers.length !== 1 || d.decode?.note || d.decode?.combine) continue;
    if (options.mpptCount !== undefined) {
      const m = PV_KEY.exec(d.key);
      if (m && Number(m[1]) > options.mpptCount) continue;
    }
    const mask = maskOf(d);
    const { minRaw, maxRaw } = rawBounds(d, mask);
    writes.push({ key: d.key, register: d.registers[0]!, mask, minRaw, maxRaw, verified: d.verified ?? false });
  }
  writes.sort((a, b) => a.register - b.register || a.key.localeCompare(b.key));

  const body = { requests, writes, metrics };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");

  return {
    hash,
    requests,
    writes,
    metrics,
    registersPolled: cadenceOf.size,
    registersRequested: requests.reduce((n, r) => n + r.count, 0),
  };
}
