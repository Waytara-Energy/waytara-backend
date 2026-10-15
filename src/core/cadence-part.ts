import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Cadence files: what a board read, as it read it. Raw register words, not decoded values, so that a mistake in a scale or an offset
 * in the catalogue can be fixed and the history read correctly afterwards; decoding happens when a report is made.
 *
 *   # waytara-cadence 1
 *   # equipment=<id> window=<ISO start of the window>
 *   ts_ms,boot,seq,r184,r186,...
 *   1792051500123,7,40,80,120,...
 *
 * One file holds the frames of one equipment in one aligned 5-minute window (UTC); at 02:00-ish the day's files are joined into one
 * `day.csv.gz`. A row is a frame; a register that was not read in that frame is an empty cell. A frame is identified by (boot, seq),
 * so the same frame written twice is one row.
 */

export const WINDOW_MS = 300_000;
export const DAY_MS = 86_400_000;
export const FORMAT_LINE = "# waytara-cadence 1";

export interface CadenceRow {
  t: number;
  boot: number;
  seq: number;
  /** register -> raw 16-bit word */
  words: Map<number, number>;
}

export const rowKey = (r: Pick<CadenceRow, "boot" | "seq">): string => `${r.boot}:${r.seq}`;

export const windowStartOf = (tMs: number): number => Math.floor(tMs / WINDOW_MS) * WINDOW_MS;
export const dayStartOf = (tMs: number): number => Math.floor(tMs / DAY_MS) * DAY_MS;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** cadence/v1/<equipment>/yyyy/mm/dd/ (UTC) */
export function dayFolder(equipmentId: string, dayStartMs: number): string {
  const d = new Date(dayStartMs);
  return `cadence/v1/${equipmentId}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`;
}

export function partKey(equipmentId: string, windowStartMs: number): string {
  const d = new Date(windowStartMs);
  return `${dayFolder(equipmentId, dayStartOf(windowStartMs))}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.csv.gz`;
}

export const dayKey = (equipmentId: string, dayStartMs: number): string => `${dayFolder(equipmentId, dayStartMs)}day.csv.gz`;

/** The start of the window a part file is for, from its name; null for anything that is not a part. */
export function partStartFromKey(key: string, dayStartMs: number): number | null {
  const m = /\/(\d{2})(\d{2})\.csv\.gz$/.exec(key);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 55 || mi % 5 !== 0) return null;
  return dayStartMs + h * 3_600_000 + mi * 60_000;
}

export function encodePart(equipmentId: string, windowLabel: string, rows: Iterable<CadenceRow>): Buffer {
  const list = [...rows].sort((a, b) => a.t - b.t || a.boot - b.boot || a.seq - b.seq);
  const regs = [...new Set(list.flatMap((r) => [...r.words.keys()]))].sort((a, b) => a - b);
  const lines = [FORMAT_LINE, `# equipment=${equipmentId} window=${windowLabel}`, ["ts_ms", "boot", "seq", ...regs.map((r) => `r${r}`)].join(",")];
  for (const r of list) lines.push([r.t, r.boot, r.seq, ...regs.map((g) => (r.words.has(g) ? r.words.get(g) : ""))].join(","));
  return gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8"), { level: 6 });
}

export class PartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartError";
  }
}

export function decodePart(file: Buffer): CadenceRow[] {
  let text: string;
  try {
    text = gunzipSync(file).toString("utf8");
  } catch {
    throw new PartError("a cadence file is not readable");
  }
  const lines = text.split("\n");
  if (lines[0] !== FORMAT_LINE) throw new PartError("a cadence file has an unknown format");
  const headerAt = lines.findIndex((l, i) => i > 0 && !l.startsWith("#"));
  if (headerAt < 0) return [];
  const header = lines[headerAt]!.split(",");
  if (header[0] !== "ts_ms" || header[1] !== "boot" || header[2] !== "seq") throw new PartError("a cadence file has an unknown header");
  const regs = header.slice(3).map((h) => {
    if (!/^r\d{1,5}$/.test(h)) throw new PartError("a cadence file has an unknown column");
    return Number(h.slice(1));
  });
  const rows: CadenceRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    const cells = line.split(",");
    const t = Number(cells[0]);
    const boot = Number(cells[1]);
    const seq = Number(cells[2]);
    if (!Number.isFinite(t) || !Number.isInteger(boot) || !Number.isInteger(seq)) throw new PartError("a cadence file has a bad row");
    const words = new Map<number, number>();
    regs.forEach((reg, j) => {
      const c = cells[3 + j];
      if (c !== undefined && c !== "") {
        const w = Number(c);
        if (!Number.isInteger(w) || w < 0 || w > 0xffff) throw new PartError("a cadence file has a bad value");
        words.set(reg, w);
      }
    });
    rows.push({ t, boot, seq, words });
  }
  return rows;
}

/** Joins row lists; a frame present in more than one list is kept once, the later list winning. */
export function mergeRows(...lists: Iterable<CadenceRow>[]): CadenceRow[] {
  const by = new Map<string, CadenceRow>();
  for (const l of lists) for (const r of l) by.set(rowKey(r), r);
  return [...by.values()].sort((a, b) => a.t - b.t || a.boot - b.boot || a.seq - b.seq);
}
