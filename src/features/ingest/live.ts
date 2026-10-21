/**
 * Go Live (task A10): while somebody watches an inverter in the dashboard, the board streams every reading at once instead of in batches
 * every 30 seconds, and the hub passes each reading on to the dashboard's live channel.
 *
 *   the dashboard      calls request_live(equipment) every ~30 s while the page is open (unchanged; it keeps "watching until ..." in the database)
 *   the hub            asks the database every few seconds whether somebody is watching (gw_live_active); if so it tells the board
 *                      {type: "live", seconds: 90} (renewed every 30 s); when nobody watches any more it tells the board to stop
 *   the board          in live mode hands over each reading as soon as it is read
 *   the hub            decodes it and publishes {t, v: {key: value}} through gw_live_tick, at most about once a second (readings that arrive
 *                      together are merged), only for values customers may see
 *
 * Nothing is stored. A board that never hears "stop" falls back to batches by itself when its 90 seconds run out.
 *
 * Speed (task T13): the dashboard also tells the hub the moment it asks (wake), so the unit is told within a fraction of a second instead of at the
 * next check; and the hub notes how long each step of a session took (request, command, first reading, first value on the channel, and the
 * rhythm after that) in the database, so the speed can be read as numbers.
 */

export interface LiveStore {
  liveActive(equipmentId: string): Promise<boolean>;
  /** false when nobody is watching (the tick was not published) */
  liveTick(equipmentId: string, tMs: number, values: Record<string, number>): Promise<boolean>;
  /** until when somebody is watching (epoch ms; the request was made 75 s before that), or null */
  liveUntil?(equipmentId: string): Promise<number | null>;
  /** notes how the latest session went (best effort) */
  recordLiveTiming?(equipmentId: string, t: LiveTiming): Promise<void>;
}

/** How long each step of one Go Live session took, in milliseconds (null = not reached yet). */
export interface LiveTiming {
  startedAt: number;
  requestToCommandMs: number | null;
  commandToFirstFrameMs: number | null;
  firstFrameToTickMs: number | null;
  requestToFirstTickMs: number | null;
  ticks: number;
  avgGapMs: number | null;
  maxGapMs: number | null;
}

export interface LiveLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface LiveDeps {
  store: LiveStore;
  log: LiveLog;
  now: () => number;
  sendCommand: (equipmentId: string, body: Record<string, unknown>) => Promise<boolean>;
}

interface State {
  active: boolean;
  nextCheck: number;
  commandedAt: number;
  /** when the FIRST command of the running session was sent (commandedAt moves on at every renewal) */
  firstCommandAt: number;
  lastTickAt: number;
  pendingT: number;
  pending: Record<string, number>;
  flushing: boolean;
  checking: boolean;
  // the timing of the running session (T13)
  startedAt: number;
  requestedAt: number;
  firstFrameAt: number;
  firstTickAt: number;
  tickTimes: number[];
  lastRecordedAt: number;
}

const CHECK_EVERY_MS = 3_000;
const RENEW_EVERY_MS = 30_000;
const LIVE_SECONDS = 90;
const TICK_EVERY_MS = 900;
const COMMAND_TTL_MS = 45_000;

export class LiveRelay {
  private readonly states = new Map<string, State>();
  private seq = 0;

  constructor(private readonly d: LiveDeps) {}

  private state(eq: string): State {
    let s = this.states.get(eq);
    if (!s) {
      s = { active: false, nextCheck: 0, commandedAt: 0, lastTickAt: 0, pendingT: 0, pending: {}, flushing: false, checking: false, firstCommandAt: 0, startedAt: 0, requestedAt: 0, firstFrameAt: 0, firstTickAt: 0, tickTimes: [], lastRecordedAt: 0 };
      this.states.set(eq, s);
    }
    return s;
  }

  /** Is somebody watching (as of the last check)? Cheap: the intake asks before it collects values for a tick. */
  isActive(equipmentId: string): boolean {
    return this.states.get(equipmentId)?.active ?? false;
  }

  /** The decoded, customer-visible readings of one frame. Passed on at most about once a second. Never throws. */
  onFrame(equipmentId: string, tMs: number, values: Record<string, number>): void {
    const s = this.state(equipmentId);
    if (!s.active) return;
    if (s.firstFrameAt === 0 && s.firstCommandAt !== 0) s.firstFrameAt = this.d.now();
    Object.assign(s.pending, values);
    s.pendingT = Math.max(s.pendingT, tMs);
    if (this.d.now() - s.lastTickAt >= TICK_EVERY_MS) void this.flush(equipmentId, s);
  }

  private async flush(equipmentId: string, s: State): Promise<void> {
    if (s.flushing || s.pendingT === 0) return;
    s.flushing = true;
    const t = s.pendingT;
    const v = s.pending;
    s.pending = {};
    s.pendingT = 0;
    s.lastTickAt = this.d.now();
    try {
      const sent = await this.d.store.liveTick(equipmentId, t, v);
      if (!sent) s.active = false; // nobody is watching any more: stop collecting until the next check says otherwise
      else this.noteTick(equipmentId, s);
    } catch (error) {
      this.d.log.warn({ equipmentId, err: error instanceof Error ? error.message : String(error) }, "a live tick could not be published");
    } finally {
      s.flushing = false;
    }
  }

  /** The dashboard has just asked (request_live): look at once instead of at the next check. Never throws. */
  async wake(equipmentId: string, boardAlive: boolean): Promise<void> {
    this.state(equipmentId).nextCheck = 0;
    await this.poll(equipmentId, boardAlive);
  }

  /** The timing of the running (or last) session, for tests and diagnostics. */
  timing(equipmentId: string): LiveTiming | null {
    const s = this.states.get(equipmentId);
    return s && s.startedAt !== 0 ? this.timingOf(s) : null;
  }

  private timingOf(s: State): LiveTiming {
    const gaps: number[] = [];
    for (let i = 1; i < s.tickTimes.length; i++) gaps.push(s.tickTimes[i]! - s.tickTimes[i - 1]!);
    const diff = (a: number, b: number) => (a !== 0 && b !== 0 ? Math.max(0, Math.round(a - b)) : null);
    return {
      startedAt: s.startedAt,
      requestToCommandMs: diff(s.firstCommandAt, s.requestedAt),
      commandToFirstFrameMs: diff(s.firstFrameAt, s.firstCommandAt),
      firstFrameToTickMs: diff(s.firstTickAt, s.firstFrameAt),
      requestToFirstTickMs: diff(s.firstTickAt, s.requestedAt),
      ticks: s.tickTimes.length,
      avgGapMs: gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      maxGapMs: gaps.length > 0 ? Math.max(...gaps) : null,
    };
  }

  private noteTick(equipmentId: string, s: State): void {
    const now = this.d.now();
    s.tickTimes.push(now);
    if (s.tickTimes.length > 120) s.tickTimes.shift();
    if (s.firstTickAt === 0) s.firstTickAt = now;
    // written at the first tick (the start), once the rhythm is visible, then every 30 s while the session runs
    const due = s.lastRecordedAt === 0 || s.tickTimes.length === 10 || now - s.lastRecordedAt >= 30_000;
    if (due && this.d.store.recordLiveTiming) {
      s.lastRecordedAt = now;
      void this.d.store.recordLiveTiming(equipmentId, this.timingOf(s)).catch(() => undefined);
    }
  }

  /** Looks after one equipment: asks whether somebody watches, starts or stops the board's live mode. Never throws. */
  async poll(equipmentId: string, boardAlive: boolean): Promise<void> {
    const s = this.state(equipmentId);
    const now = this.d.now();
    if (s.checking || now < s.nextCheck) return;
    s.checking = true;
    s.nextCheck = now + CHECK_EVERY_MS;
    try {
      if (!boardAlive) {
        s.active = false;
        s.commandedAt = 0;
        return;
      }
      const watching = await this.d.store.liveActive(equipmentId);
      if (watching) {
        s.active = true;
        if (s.commandedAt === 0 || now - s.commandedAt >= RENEW_EVERY_MS) {
          const first = s.commandedAt === 0;
          if (first) await this.beginTiming(equipmentId, s, now);
          const sent = await this.command(equipmentId, LIVE_SECONDS, now);
          if (sent) {
            s.commandedAt = this.d.now();
            if (first) s.firstCommandAt = s.commandedAt;
          }
        }
      } else if (s.commandedAt !== 0) {
        s.active = false;
        await this.command(equipmentId, 0, now); // best effort: the board also stops by itself
        s.commandedAt = 0;
        s.pending = {};
        s.pendingT = 0;
      } else {
        s.active = false;
      }
    } catch (error) {
      this.d.log.warn({ equipmentId, err: error instanceof Error ? error.message : String(error) }, "the live check failed, will retry");
    } finally {
      s.checking = false;
    }
  }

  /** A new session: when was it asked for (the database's request time), and when did the hub see it. */
  private async beginTiming(equipmentId: string, s: State, now: number): Promise<void> {
    s.startedAt = now;
    s.firstCommandAt = 0;
    s.firstFrameAt = 0;
    s.firstTickAt = 0;
    s.tickTimes = [];
    s.lastRecordedAt = 0;
    s.requestedAt = now;
    try {
      const until = (await this.d.store.liveUntil?.(equipmentId)) ?? null;
      if (until !== null) s.requestedAt = Math.min(now, until - 75_000);
    } catch {
      /* the start is then timed from the moment the hub saw it */
    }
  }

  private command(equipmentId: string, seconds: number, now: number): Promise<boolean> {
    return this.d.sendCommand(equipmentId, { id: `l${now.toString(36)}${(++this.seq).toString(36)}`, type: "live", seconds, issued_at: now, expires_at: now + COMMAND_TTL_MS });
  }
}
