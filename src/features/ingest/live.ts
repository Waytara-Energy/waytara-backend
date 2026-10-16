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
 */

export interface LiveStore {
  liveActive(equipmentId: string): Promise<boolean>;
  /** false when nobody is watching (the tick was not published) */
  liveTick(equipmentId: string, tMs: number, values: Record<string, number>): Promise<boolean>;
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
  lastTickAt: number;
  pendingT: number;
  pending: Record<string, number>;
  flushing: boolean;
  checking: boolean;
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
      s = { active: false, nextCheck: 0, commandedAt: 0, lastTickAt: 0, pendingT: 0, pending: {}, flushing: false, checking: false };
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
    } catch (error) {
      this.d.log.warn({ equipmentId, err: error instanceof Error ? error.message : String(error) }, "a live tick could not be published");
    } finally {
      s.flushing = false;
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
          const sent = await this.command(equipmentId, LIVE_SECONDS, now);
          if (sent) s.commandedAt = now;
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

  private command(equipmentId: string, seconds: number, now: number): Promise<boolean> {
    return this.d.sendCommand(equipmentId, { id: `l${now.toString(36)}${(++this.seq).toString(36)}`, type: "live", seconds, issued_at: now, expires_at: now + COMMAND_TTL_MS });
  }
}
