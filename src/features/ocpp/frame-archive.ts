import { gunzipSync, gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import type { ObjectStore } from "../../storage/object-store.js";
import { hideTags } from "./frame-log.js";

/**
 * Keeps every message a charger exchanged with the server, for later analysis (what did the charger really send, how did a session
 * look on the wire, was a fault visible before it happened). The file store cannot append, so the messages are collected in memory and
 * written as one small gzipped file per charger every few minutes:
 *
 *   ocpp/v1/<equipment id>/<yyyy>/<mm>/<dd>/<HHmmss>-<run>-<n>.ndjson.gz     (UTC; one JSON object per line: {t, d, f})
 *
 * `d` is "in" (from the charger) or "out" (from the server); `f` is the message with card identifiers hidden. A file is never
 * rewritten, so a restart cannot overwrite earlier files (<run> is different every time the service starts). What is still in memory
 * when the service stops is written first; after a crash the last few minutes are lost, which is acceptable for a log.
 * Structured data (sessions, samples, events) lives in the database, not here.
 */

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface ArchivedFrame {
  t: string;
  d: "in" | "out";
  f: string;
}

const MAX_FRAME_CHARS = 8000;
const MAX_BUFFERED_PER_CHARGER = 20_000;
export const ARCHIVE_PREFIX = "ocpp/v1/";
const FILE = /^ocpp\/v1\/[^/]+\/(\d{4})\/(\d{2})\/(\d{2})\//;

export interface FrameArchiveDeps {
  store: ObjectStore;
  log: Logger;
  now?: () => number;
  /** how long to keep files, in days */
  retentionDays?: number;
}

export class FrameArchive {
  private readonly buffers = new Map<string, ArchivedFrame[]>();
  private readonly now: () => number;
  private readonly run = randomBytes(2).toString("hex");
  private readonly retentionDays: number;
  private n = 0;
  private flushing: Promise<void> | null = null;
  written = 0;
  failures = 0;
  dropped = 0;

  constructor(private readonly d: FrameArchiveDeps) {
    this.now = d.now ?? Date.now;
    this.retentionDays = d.retentionDays ?? 90;
  }

  add(equipmentId: string, direction: "in" | "out", raw: string): void {
    let list = this.buffers.get(equipmentId);
    if (!list) {
      list = [];
      this.buffers.set(equipmentId, list);
    }
    if (list.length >= MAX_BUFFERED_PER_CHARGER) {
      // the file store has been unreachable for a long time: keep the newest
      list.splice(0, list.length - MAX_BUFFERED_PER_CHARGER + 1);
      this.dropped++;
    }
    const hidden = hideTags(raw);
    list.push({ t: new Date(this.now()).toISOString(), d: direction, f: hidden.length > MAX_FRAME_CHARS ? `${hidden.slice(0, MAX_FRAME_CHARS)}…` : hidden });
  }

  /** Writes what is collected. Calls do not overlap; a charger whose write failed keeps its messages for the next time. */
  flush(): Promise<void> {
    const next = (this.flushing ?? Promise.resolve()).then(() => this.flushNow());
    this.flushing = next.catch(() => undefined);
    return next;
  }

  private async flushNow(): Promise<void> {
    for (const [equipmentId, list] of this.buffers) {
      if (list.length === 0) continue;
      const taken = list.splice(0, list.length);
      const at = new Date(this.now());
      const key = `${ARCHIVE_PREFIX}${equipmentId}/${dayPath(at)}/${at.toISOString().slice(11, 19).replace(/:/g, "")}-${this.run}-${++this.n}.ndjson.gz`;
      try {
        await this.d.store.put(key, gzipSync(Buffer.from(taken.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8")), "application/gzip");
        this.written++;
      } catch (error) {
        this.failures++;
        list.unshift(...taken); // keep them for the next time
        this.d.log.warn({ equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not save the charger message log");
      }
      if (list.length === 0) this.buffers.delete(equipmentId);
    }
  }

  /** The messages of one UTC day for one charger, oldest first, as lines of JSON. At most `maxLines` (the first ones). */
  async readDay(equipmentId: string, day: string, maxLines = 20_000): Promise<{ lines: string[]; truncated: boolean }> {
    const [y, m, d] = day.split("-");
    const files = (await this.d.store.list(`${ARCHIVE_PREFIX}${equipmentId}/${y}/${m}/${d}/`)).sort((a, b) => a.key.localeCompare(b.key));
    const lines: string[] = [];
    for (const f of files) {
      const body = await this.d.store.get(f.key);
      if (!body) continue;
      for (const line of gunzipSync(body).toString("utf8").split("\n")) {
        if (!line) continue;
        if (lines.length >= maxLines) return { lines, truncated: true };
        lines.push(line);
      }
    }
    return { lines, truncated: false };
  }

  /** Deletes files older than the retention. Returns how many were deleted. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.retentionDays * 86_400_000;
    let deleted = 0;
    for (const folder of await this.d.store.listFolders(ARCHIVE_PREFIX)) {
      for (const f of await this.d.store.list(folder)) {
        const m = FILE.exec(f.key);
        if (!m) continue;
        if (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) <= cutoff) {
          await this.d.store.delete(f.key);
          deleted++;
        }
      }
    }
    return deleted;
  }
}

function dayPath(at: Date): string {
  return at.toISOString().slice(0, 10).replace(/-/g, "/");
}

const FLUSH_EVERY_MS = 10 * 60_000;
const SWEEP_FIRST_AFTER_MS = 5 * 60_000;
const SWEEP_EVERY_MS = 12 * 3_600_000;

/** Writes the collected messages every 10 minutes and removes old files twice a day. */
export function startFrameArchive(archive: FrameArchive, log: Logger): { stop(): Promise<void> } {
  const flushTimer = setInterval(() => void archive.flush(), FLUSH_EVERY_MS);
  flushTimer.unref();
  let stopped = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  const sweep = async () => {
    try {
      const n = await archive.sweep();
      if (n > 0) log.info({ deleted: n }, "old charger message logs removed");
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, "removing old charger message logs failed");
    }
    if (!stopped) {
      sweepTimer = setTimeout(() => void sweep(), SWEEP_EVERY_MS);
      sweepTimer.unref();
    }
  };
  sweepTimer = setTimeout(() => void sweep(), SWEEP_FIRST_AFTER_MS);
  sweepTimer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(flushTimer);
      if (sweepTimer) clearTimeout(sweepTimer);
      await archive.flush(); // what is still in memory is written before the service stops
    },
  };
}
