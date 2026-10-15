/**
 * 15-minute summaries, built on the backend from the raw readings (decision S3).
 *
 * This is the same arithmetic as the working unit firmware (rollup.h in the esp32 scripts repository), written as a pure function so a late
 * or repeated reading can simply be added and the affected buckets recomputed:
 *
 *   A reading holds from its time until the next reading of the same value, but no longer than
 *   hold = min(7200, max(60, 2 x cadence)) seconds (sample-and-hold). The held stretch is cut to the 15-minute buckets it touches.
 *
 *   Per bucket:  wsum     sum of (value x seconds held)
 *                covered  seconds held (gaps with no readings are NOT covered)
 *                min, max, last   over the readings whose held stretch touches the bucket (last = the latest of them)
 *                pos, neg positive and negative parts of wsum (kept only when the bucket has a negative value)
 *                n        readings whose own time lies inside the bucket
 *
 * Buckets start on the quarter hour (IST and UTC quarter hours coincide). Times are seconds since 1970.
 */

export const BUCKET_S = 900;

export function holdFor(cadenceSeconds: number | null | undefined): number {
  const c = cadenceSeconds && cadenceSeconds > 0 ? cadenceSeconds : 30;
  return Math.min(7200, Math.max(60, 2 * c));
}

export const bucketStartOf = (t: number): number => Math.floor(t / BUCKET_S) * BUCKET_S;

export interface Reading {
  t: number;
  v: number;
}

export interface BucketStats {
  start: number;
  wsum: number;
  covered: number;
  min: number;
  max: number;
  last: number;
  /** present only when the bucket contains a negative value */
  pos?: number;
  neg?: number;
  n: number;
}

/**
 * Computes one bucket from the readings of one value, sorted by time.
 * `now` limits how far the newest reading is considered to hold (for a closed bucket pass its end).
 * Returns null when the bucket has neither readings nor held time.
 */
export function computeBucket(readings: readonly Reading[], start: number, hold: number, now: number): BucketStats | null {
  const end = start + BUCKET_S;
  let wsum = 0;
  let covered = 0;
  let pos = 0;
  let neg = 0;
  let min = 0;
  let max = 0;
  let last = 0;
  let lastT = -Infinity;
  let any = false;
  let n = 0;

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i]!;
    if (r.t >= start && r.t < end) n++;
    if (r.t >= end) break; // sorted: nothing later can touch this bucket
    const next = i + 1 < readings.length ? readings[i + 1]!.t : now;
    const segEnd = Math.min(Math.max(next, r.t), r.t + hold);
    const a = Math.max(r.t, start);
    const b = Math.min(segEnd, end);
    if (b <= a) continue;
    const seconds = b - a;
    wsum += r.v * seconds;
    covered += seconds;
    if (r.v > 0) pos += r.v * seconds;
    else if (r.v < 0) neg += -r.v * seconds;
    if (!any) {
      min = max = r.v;
      any = true;
    } else {
      if (r.v < min) min = r.v;
      if (r.v > max) max = r.v;
    }
    if (r.t >= lastT) {
      last = r.v;
      lastT = r.t;
    }
  }

  if (covered <= 0 && n === 0) return null;
  const out: BucketStats = { start, wsum, covered, min: any ? min : 0, max: any ? max : 0, last: any ? last : 0, n };
  if (any && min < 0) {
    out.pos = pos;
    out.neg = neg;
  }
  return out;
}

export interface ClosedBucket extends BucketStats {
  key: string;
}

interface KeyState {
  hold: number;
  readings: Reading[]; // sorted by t
  dirty: Set<number>; // bucket starts changed since they were last handed out
}

export interface RollupOptions {
  /** how long raw readings are kept for recomputation, in seconds (default 3 hours) */
  retainSeconds?: number;
}

/**
 * Keeps the recent readings of many values and hands out finished buckets.
 * A bucket is handed out when it is finished and new or changed; a late reading makes the buckets it touches changed, so they are
 * handed out again in full. The receiver therefore REPLACES a bucket, it never adds to it (gw_ingest in a later task).
 */
export class RollupEngine {
  private readonly keys = new Map<string, KeyState>();
  private readonly retain: number;

  constructor(options: RollupOptions = {}) {
    this.retain = options.retainSeconds ?? 3 * 3600;
  }

  private state(key: string, cadenceSeconds?: number | null): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = { hold: holdFor(cadenceSeconds), readings: [], dirty: new Set() };
      this.keys.set(key, s);
    } else if (cadenceSeconds != null) {
      s.hold = holdFor(cadenceSeconds);
    }
    return s;
  }

  /** Adds one reading. A repeated reading (same time and value) is ignored. Readings may arrive late or out of order. */
  add(key: string, t: number, v: number, cadenceSeconds?: number | null): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const s = this.state(key, cadenceSeconds);
    const rs = s.readings;
    // insert in time order (almost always the end)
    let i = rs.length;
    while (i > 0 && rs[i - 1]!.t > t) i--;
    if (i > 0 && rs[i - 1]!.t === t && rs[i - 1]!.v === v) return;
    rs.splice(i, 0, { t, v });
    // the buckets whose numbers can change: from the previous reading's stretch to the end of this reading's own hold
    const from = i > 0 ? rs[i - 1]!.t : t;
    const to = t + s.hold;
    for (let b = bucketStartOf(from); b <= bucketStartOf(to); b += BUCKET_S) s.dirty.add(b);
    // a later reading's stretch was cut short by this one
    if (i + 1 < rs.length) {
      const nxt = rs[i + 1]!.t;
      for (let b = bucketStartOf(t); b <= bucketStartOf(Math.min(nxt, t + s.hold)); b += BUCKET_S) s.dirty.add(b);
    }
  }

  /** Buckets that are finished at `now` (they ended at or before the current quarter hour) and new or changed. */
  collectClosed(now: number): ClosedBucket[] {
    const boundary = bucketStartOf(now);
    const out: ClosedBucket[] = [];
    for (const [key, s] of this.keys) {
      for (const start of [...s.dirty].sort((a, b) => a - b)) {
        if (start >= boundary) continue;
        s.dirty.delete(start);
        const b = computeBucket(s.readings, start, s.hold, start + BUCKET_S);
        if (b && b.covered > 0) out.push({ key, ...b });
      }
    }
    this.prune(now);
    return out;
  }

  /** Puts buckets that were handed out but could not be stored back, so the next collectClosed returns them again. */
  requeue(buckets: readonly ClosedBucket[]): void {
    for (const b of buckets) this.keys.get(b.key)?.dirty.add(b.start);
  }

  /** The current, unfinished bucket of one value as it stands now. */
  open(key: string, now: number): BucketStats | null {
    const s = this.keys.get(key);
    if (!s) return null;
    return computeBucket(s.readings, bucketStartOf(now), s.hold, now);
  }

  /** Drops readings no later bucket can need, keeping the newest one before the cut-off because its hold may reach into it. */
  private prune(now: number): void {
    const cutoff = bucketStartOf(now) - this.retain;
    for (const s of this.keys.values()) {
      const rs = s.readings;
      let k = 0;
      while (k + 1 < rs.length && rs[k + 1]!.t < cutoff) k++;
      if (k > 0) rs.splice(0, k);
      for (const d of s.dirty) if (d < cutoff) s.dirty.delete(d);
    }
  }

  /** For tests and diagnostics. */
  size(): { keys: number; readings: number } {
    let readings = 0;
    for (const s of this.keys.values()) readings += s.readings.length;
    return { keys: this.keys.size, readings };
  }
}
