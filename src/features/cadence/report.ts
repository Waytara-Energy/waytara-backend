import { decodeMetric, type MetricDef } from "../../core/decode.js";
import type { CadenceRow } from "../../core/cadence-part.js";
import type { EquipmentProfile, MetricLabel } from "../ingest/store.js";

/**
 * Turns stored raw words into a report: which values exist for this person, the decoded rows, and the CSV text.
 * Pure functions; the route does the reading and the access checks.
 */

export type Scope = "staff" | "customer";

export interface ReportColumn {
  key: string;
  label: string;
  unit: string | null;
  category: string | null;
  cadenceSeconds: number | null;
  def: MetricDef;
}

const IST_MS = 19_800_000;

export const istTimestamp = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 19).replace("T", " ");

/** Everything this person may ask for: readings with registers; customers only those the customer view shows. */
export function availableColumns(profile: EquipmentProfile, scope: Scope): ReportColumn[] {
  const out: ReportColumn[] = [];
  const seen = new Set<string>();
  for (const m of profile.metrics) {
    if (m.direction !== "read" || m.registers.length === 0 || seen.has(m.key)) continue;
    seen.add(m.key);
    if (scope === "customer" && !m.showForUser) continue;
    const l: MetricLabel | undefined = profile.labels?.[m.key];
    out.push({ key: m.key, label: l?.label ?? m.key, unit: l?.unit ?? null, category: l?.category ?? null, cadenceSeconds: m.cadenceSeconds ?? null, def: m });
  }
  return out.sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.label.localeCompare(b.label));
}

/** The requested keys in the order asked, or the keys that are not available to this person (never said apart from "unknown"). */
export function pickColumns(available: readonly ReportColumn[], keys: readonly string[]): { ok: true; columns: ReportColumn[] } | { ok: false; unknown: string[] } {
  const by = new Map(available.map((c) => [c.key, c]));
  const unknown = keys.filter((k) => !by.has(k));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, columns: [...new Set(keys)].map((k) => by.get(k)!) };
}

export const columnTitle = (c: Pick<ReportColumn, "label" | "unit">): string => (c.unit ? `${c.label} (${c.unit})` : c.label);

export type Cell = number | string | null;

/** One row per frame that carried at least one of the columns; a value whose registers were not all in the frame is empty. */
export function decodeRows(rows: readonly CadenceRow[], columns: readonly ReportColumn[]): { t: number; cells: Cell[] }[] {
  const out: { t: number; cells: Cell[] }[] = [];
  for (const r of rows) {
    let any = false;
    const cells = columns.map((c): Cell => {
      if (!c.def.registers.every((g) => r.words.has(g))) return null;
      const d = decodeMetric(c.def, r.words);
      if (!d.ok) return null;
      any = true;
      return d.value;
    });
    if (any) out.push({ t: r.t, cells });
  }
  return out;
}

export const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A text value that a spreadsheet would read as a formula gets a leading apostrophe. */
const safeText = (v: string): string => csvCell(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export const csvHeader = (columns: readonly Pick<ReportColumn, "label" | "unit">[]): string => ["Time (IST)", ...columns.map(columnTitle)].map(csvCell).join(",") + "\r\n";

export function csvLines(rows: readonly { t: number; cells: Cell[] }[]): string {
  let out = "";
  for (const r of rows) out += istTimestamp(r.t) + "," + r.cells.map((c) => (c === null ? "" : typeof c === "number" ? String(c) : safeText(c))).join(",") + "\r\n";
  return out;
}
