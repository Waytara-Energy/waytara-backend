import { WINDOW_MS, decodePart, encodePart, mergeRows, partKey, rowKey, windowStartOf, type CadenceRow } from "../../core/cadence-part.js";
import type { ObjectStore } from "../../storage/object-store.js";

/**
 * Collects the frames a board sends into 5-minute windows and writes each window to the file store as one file once it is over.
 * A frame that arrives late for a window already written rewrites that window (the rows are merged, never lost). Until a window
 * is written its frames are in memory only, so the intake acknowledges a frame to the board only after `durableBeforeMs` has passed
 * it; a restart then loses nothing, because the board still holds what was not acknowledged.
 */

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface FrameIn {
  t: number;
  boot: number;
  seq: number;
  blocks: readonly (readonly [number, readonly number[]])[];
}

interface Win {
  rows: Map<string, CadenceRow>;
  dirty: boolean;
  /** a file for this window may already exist (we restarted, or the frames are late): read it and join before writing */
  mustJoin: boolean;
}

const GRACE_MS = 15_000; // frames of a window can still be on their way when it ends
const KEEP_AFTER_WRITE_MS = 10 * 60_000; // late frames join without reading the file again
const MAX_WINDOWS_PER_EQUIPMENT = 600;

export interface CadenceWriterDeps {
  store: ObjectStore;
  log: Logger;
  now?: () => number;
}

export class CadenceWriter {
  private readonly windows = new Map<string, Map<number, Win>>();
  private readonly now: () => number;
  private readonly startedAt: number;
  private running: Promise<void> | null = null;
  written = 0;
  failures = 0;

  constructor(private readonly d: CadenceWriterDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Puts frames into their windows (memory only; nothing is written until `tick`). */
  add(equipmentId: string, frames: readonly FrameIn[]): void {
    let byWindow = this.windows.get(equipmentId);
    if (!byWindow) this.windows.set(equipmentId, (byWindow = new Map()));
    for (const f of frames) {
      if (f.blocks.length === 0) continue;
      const start = windowStartOf(f.t);
      let w = byWindow.get(start);
      if (!w) {
        if (byWindow.size >= MAX_WINDOWS_PER_EQUIPMENT) continue;
        // A file can exist already unless this window began after we started and is still recent enough that we have not
        // dropped it from memory (a dropped window that gets late frames must join with what was written before).
        const fresh = start >= this.startedAt && start + WINDOW_MS + KEEP_AFTER_WRITE_MS > this.now();
        byWindow.set(start, (w = { rows: new Map(), dirty: false, mustJoin: !fresh }));
      }
      const words = new Map<number, number>();
      for (const [first, ws] of f.blocks) ws.forEach((word, i) => words.set(first + i, word));
      const row: CadenceRow = { t: f.t, boot: f.boot, seq: f.seq, words };
      w.rows.set(rowKey(row), row);
      w.dirty = true;
    }
  }

  /** Frames before this time (epoch ms) are safely in the file store; the intake may acknowledge them. */
  durableBeforeMs(equipmentId: string): number {
    let first = Infinity;
    for (const [start, w] of this.windows.get(equipmentId) ?? []) if (w.dirty && start < first) first = start;
    return first;
  }

  /** Writes every finished window that has something new. Safe to call at any time and from several places. */
  tick(nowMs: number = this.now()): Promise<void> {
    return this.run(nowMs, false);
  }

  /** Writes everything, finished or not (shutting down). */
  flushAll(): Promise<void> {
    return this.run(this.now(), true);
  }

  private run(nowMs: number, all: boolean): Promise<void> {
    const go = async () => {
      for (const [equipmentId, byWindow] of this.windows) {
        for (const [start, w] of [...byWindow].sort((a, b) => a[0] - b[0])) {
          if (w.dirty && (all || start + WINDOW_MS + GRACE_MS <= nowMs)) await this.write(equipmentId, start, w);
          if (!w.dirty && start + WINDOW_MS + KEEP_AFTER_WRITE_MS < nowMs) byWindow.delete(start);
        }
        if (byWindow.size === 0) this.windows.delete(equipmentId);
      }
    };
    // calls that overlap wait for the one in progress and then run again, so nothing added meanwhile is missed
    const next = (this.running ?? Promise.resolve()).catch(() => undefined).then(go);
    this.running = next;
    void next.finally(() => {
      if (this.running === next) this.running = null;
    });
    return next;
  }

  private async write(equipmentId: string, start: number, w: Win): Promise<void> {
    const key = partKey(equipmentId, start);
    try {
      if (w.mustJoin) {
        const existing = await this.d.store.get(key);
        if (existing) {
          try {
            for (const r of decodePart(existing)) if (!w.rows.has(rowKey(r))) w.rows.set(rowKey(r), r);
          } catch (error) {
            // a damaged file is replaced rather than blocking the window for ever
            this.d.log.warn({ equipmentId, key, err: error instanceof Error ? error.message : String(error) }, "replacing an unreadable cadence file");
          }
        }
        w.mustJoin = false;
      }
      await this.d.store.put(key, encodePart(equipmentId, new Date(start).toISOString(), mergeRows(w.rows.values())), "application/gzip");
      w.dirty = false;
      this.written++;
    } catch (error) {
      this.failures++;
      this.d.log.warn({ equipmentId, key, err: error instanceof Error ? error.message : String(error) }, "writing a cadence file failed, will retry");
    }
  }

  stats(): { equipments: number; windows: number; dirty: number; written: number; failures: number } {
    let windows = 0;
    let dirty = 0;
    for (const m of this.windows.values()) for (const w of m.values()) {
        windows++;
        if (w.dirty) dirty++;
      }
    return { equipments: this.windows.size, windows, dirty, written: this.written, failures: this.failures };
  }
}
