import type { ConnLog } from "./connection.js";

/**
 * Database work that failed because the database could not be reached, kept and tried again (a charge's stop report, closing a charge whose
 * stop never came, picking up the open sessions after a reconnect). The charger is answered "accepted" at once, so it does not give up on the
 * message after a few tries as it did when the answer was an error; the work is done as soon as the database is back.
 *
 * One job per key (a charge). A job of a higher priority replaces a lower one with the same key (the charger's real stop report over WayTara's own
 * closing of the charge); a lower one is dropped while a higher one waits. It lives in the memory of this process: a restart loses what was
 * waiting, and the message log in the file store still holds the charger's frames.
 */

export interface RetryPoolOptions {
  log: ConnLog;
  /** the waits between tries, the last one repeated (default 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min) */
  delaysMs?: number[];
  /** how long a job is kept before it is given up (default 6 hours) */
  giveUpMs?: number;
  now?: () => number;
}

interface Job {
  priority: number;
  run: () => Promise<void>;
  attempts: number;
  startedAt: number;
  timer: NodeJS.Timeout | undefined;
}

const DEFAULT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const DEFAULT_GIVE_UP_MS = 6 * 3_600_000;

export class RetryPool {
  private readonly jobs = new Map<string, Job>();
  private readonly delays: number[];
  private readonly giveUpMs: number;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly o: RetryPoolOptions) {
    this.delays = o.delaysMs && o.delaysMs.length > 0 ? o.delaysMs : DEFAULT_DELAYS_MS;
    this.giveUpMs = o.giveUpMs ?? DEFAULT_GIVE_UP_MS;
    this.now = o.now ?? Date.now;
  }

  /** Keeps `run` to be tried again later; replaces a waiting job of a lower or equal priority, and is dropped if a higher one waits. */
  add(key: string, priority: number, run: () => Promise<void>): void {
    if (this.stopped) return;
    const existing = this.jobs.get(key);
    if (existing) {
      if (existing.priority > priority) return;
      if (existing.timer) clearTimeout(existing.timer);
    }
    const job: Job = { priority, run, attempts: 0, startedAt: existing?.startedAt ?? this.now(), timer: undefined };
    this.jobs.set(key, job);
    this.schedule(key, job);
  }

  /** Forgets a waiting job (its work was done another way). */
  cancel(key: string): void {
    const job = this.jobs.get(key);
    if (job?.timer) clearTimeout(job.timer);
    this.jobs.delete(key);
  }

  has(key: string): boolean {
    return this.jobs.has(key);
  }

  pending(): number {
    return this.jobs.size;
  }

  stop(): void {
    this.stopped = true;
    for (const j of this.jobs.values()) if (j.timer) clearTimeout(j.timer);
    this.jobs.clear();
  }

  private schedule(key: string, job: Job): void {
    const wait = this.delays[Math.min(job.attempts, this.delays.length - 1)]!;
    job.timer = setTimeout(() => void this.attempt(key, job), wait);
    job.timer.unref();
  }

  private async attempt(key: string, job: Job): Promise<void> {
    if (this.jobs.get(key) !== job) return; // replaced or cancelled meanwhile
    job.attempts++;
    try {
      await job.run();
      if (this.jobs.get(key) === job) this.jobs.delete(key);
    } catch (error) {
      if (this.jobs.get(key) !== job) return;
      if (this.now() - job.startedAt > this.giveUpMs) {
        this.jobs.delete(key);
        this.o.log.warn({ key, attempts: job.attempts, err: error instanceof Error ? error.message : String(error) }, "gave up retrying database work");
        return;
      }
      this.schedule(key, job);
    }
  }
}
