import { DAY_MS, WINDOW_MS, dayFolder, dayKey, dayStartOf, decodePart, mergeRows, partStartFromKey, type CadenceRow } from "../../core/cadence-part.js";
import { encodePart } from "../../core/cadence-part.js";
import type { ObjectStore, StoredFile } from "../../storage/object-store.js";
import type { Logger } from "./writer.js";

/**
 * Reads cadence data back, and joins each day's 5-minute files into one `day.csv.gz` so that a report of a week reads 7 files, not
 * 2,000. Late frames can rewrite a part after its day was joined (a board may hold frames for up to 36 hours), so the reader adds
 * every part that is newer than the day file, and the join is repeated for the last few days.
 */

const READ_CONCURRENCY = 12;

async function inParallel<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class CadenceArchive {
  constructor(
    private readonly store: ObjectStore,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private async day(equipmentId: string, dayStart: number): Promise<{ folder: StoredFile[]; dayFile: StoredFile | undefined; parts: { file: StoredFile; start: number }[] }> {
    const folder = await this.store.list(dayFolder(equipmentId, dayStart));
    const dayName = dayKey(equipmentId, dayStart);
    const dayFile = folder.find((f) => f.key === dayName);
    const parts = folder.flatMap((file) => {
      const start = partStartFromKey(file.key, dayStart);
      return start === null ? [] : [{ file, start }];
    });
    return { folder, dayFile, parts };
  }

  /** Every frame of this equipment from `fromMs` up to but not including `toMs`, oldest first. */
  async read(equipmentId: string, fromMs: number, toMs: number): Promise<CadenceRow[]> {
    if (toMs <= fromMs) return [];
    const days: number[] = [];
    for (let d = dayStartOf(fromMs); d < toMs; d += DAY_MS) days.push(d);
    const perDay = await inParallel(days, 3, async (dayStart) => {
      const { dayFile, parts } = await this.day(equipmentId, dayStart);
      const wanted = parts.filter((p) => p.start + WINDOW_MS > fromMs && p.start < toMs && (!dayFile || p.file.modified > dayFile.modified));
      const lists: CadenceRow[][] = [];
      if (dayFile) {
        const bytes = await this.store.get(dayFile.key);
        if (bytes) lists.push(decodePart(bytes));
      }
      const fetched = await inParallel(wanted, READ_CONCURRENCY, async (p) => {
        const bytes = await this.store.get(p.file.key);
        return bytes ? decodePart(bytes) : [];
      });
      lists.push(...fetched);
      return mergeRows(...lists);
    });
    return mergeRows(...perDay).filter((r) => r.t >= fromMs && r.t < toMs);
  }

  /**
   * Joins the 5-minute files of one finished day into its day file (together with what the day file already holds). Nothing is
   * written when no part is newer than the day file. Returns how many rows the day file holds, or null when it was left alone.
   */
  async mergeDay(equipmentId: string, dayStart: number): Promise<number | null> {
    if (dayStart + DAY_MS > this.now()) return null; // the day is not over
    const { dayFile, parts } = await this.day(equipmentId, dayStart);
    const fresh = parts.filter((p) => !dayFile || p.file.modified > dayFile.modified);
    if (fresh.length === 0) return null;
    const lists: CadenceRow[][] = [];
    if (dayFile) {
      const bytes = await this.store.get(dayFile.key);
      if (bytes) lists.push(decodePart(bytes));
    }
    lists.push(...(await inParallel(fresh, READ_CONCURRENCY, async (p) => {
      const bytes = await this.store.get(p.file.key);
      return bytes ? decodePart(bytes) : [];
    })));
    const rows = mergeRows(...lists);
    await this.store.put(dayKey(equipmentId, dayStart), encodePart(equipmentId, `${new Date(dayStart).toISOString().slice(0, 10)} (whole day)`, rows), "application/gzip");
    return rows.length;
  }

  /** The last `lookbackDays` finished days of every equipment that has files. Problems with one day are logged and do not stop the rest. */
  async mergeFinishedDays(lookbackDays: number): Promise<{ merged: number; failed: number }> {
    let merged = 0;
    let failed = 0;
    const today = dayStartOf(this.now());
    for (const folder of await this.store.listFolders("cadence/v1/")) {
      const equipmentId = folder.slice("cadence/v1/".length).replace(/\/$/, "");
      for (let i = 1; i <= lookbackDays; i++) {
        try {
          if ((await this.mergeDay(equipmentId, today - i * DAY_MS)) !== null) merged++;
        } catch (error) {
          failed++;
          this.log.warn({ equipmentId, daysAgo: i, err: error instanceof Error ? error.message : String(error) }, "joining a day of cadence files failed");
        }
      }
    }
    return { merged, failed };
  }
}
