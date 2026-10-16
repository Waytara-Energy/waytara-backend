import type { MetricDef } from "../../core/decode.js";
import type { RegisterMap, WriteSlot } from "../../core/register-map.js";
import { encodeSetting, formatSetting } from "../../core/setting-value.js";

/**
 * The settings write-back (task A9): changes a person makes in the dashboard reach the inverter, are read back, and are confirmed or
 * reported as failed in the settings log (equipment_configs), the same contract the old agent kept:
 *
 *   a person asks          a row with another source ("customer_dashboard", ...): the database lists it as pending for 10 minutes
 *   the backend checks     the setting is on the unit's allow-list, is verified, is a value the setting can hold and in range
 *   the backend commands   a sealed command {id, key, reg, mask, raw, expires_at}; the unit checks it again, writes only the bits of the
 *                          setting (read-modify-write), reads the register back and answers with a "write_result" event
 *   the backend records    agent_write_ok (value = what was read back) or agent_write_failed (value = what the inverter still holds,
 *                          previous_value = what was asked for, notes = why)
 *
 * It also records what the unit reports about a setting (agent_initial_read) at first sight and whenever the value changes by itself (a
 * change made on the inverter's own screen), but never while a person's request for that setting is waiting: a report would be newer than
 * the request and hide it (the database refuses that too).
 */

export interface PendingWrite {
  id: number;
  key: string;
  value: string;
  by: string | null;
}

export interface SettingRow {
  key_name: string;
  setting_value: string;
  source: "agent_initial_read" | "agent_write_ok" | "agent_write_failed";
  previous_value?: string | null;
  notes?: string;
  written_by?: string | null;
}

export interface SettingsStore {
  pendingWrites(equipmentId: string): Promise<PendingWrite[]>;
  reportSettings(equipmentId: string, rows: SettingRow[]): Promise<number>;
  /** the newest log text of every setting, by key */
  lastSettings(equipmentId: string): Promise<Map<string, string>>;
}

export interface SettingsLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface SettingsDeps {
  store: SettingsStore;
  log: SettingsLog;
  now: () => number;
  /** false (default): a setting not marked verified in the catalogue is refused with a plain reason */
  allowUnverified: boolean;
  /** seals and publishes a command to the board; false if it could not be sent */
  sendCommand: (equipmentId: string, body: Record<string, unknown>) => Promise<boolean>;
}

export interface SettingsContext {
  equipmentId: string;
  map: RegisterMap;
  /** the board checked in recently */
  boardAlive: boolean;
}

interface Inflight {
  configId: number;
  key: string;
  requested: string;
  by: string | null;
  sentAt: number;
}

interface State {
  known: Map<string, string>;
  seeded: boolean;
  observed: Map<string, string>;
  inflight: Map<string, Inflight>;
  handled: Set<number>;
  nextPoll: number;
  busy: boolean;
  seq: number;
}

const POLL_EVERY_MS = 5_000;
/** a command the unit receives later than this is ignored by the unit */
export const COMMAND_TTL_MS = 45_000;
/** no answer after this long: the request is reported as failed */
const INFLIGHT_TIMEOUT_MS = 60_000;
const HANDLED_LIMIT = 500;
const REPORT_BATCH = 100;

export class SettingsSync {
  private readonly states = new Map<string, State>();

  constructor(private readonly d: SettingsDeps) {}

  private state(equipmentId: string): State {
    let s = this.states.get(equipmentId);
    if (!s) {
      s = { known: new Map(), seeded: false, observed: new Map(), inflight: new Map(), handled: new Set(), nextPoll: 0, busy: false, seq: 0 };
      this.states.set(equipmentId, s);
    }
    return s;
  }

  /** A setting's value as the unit reported it in a data frame (already decoded, as the log's text). */
  observe(equipmentId: string, key: string, text: string): void {
    this.state(equipmentId).observed.set(key, text);
  }

  /** Does the work that is due for one equipment (called by the intake's timer; never throws). */
  async poll(ctx: SettingsContext): Promise<void> {
    const s = this.state(ctx.equipmentId);
    const now = this.d.now();
    if (s.busy || now < s.nextPoll) return;
    s.busy = true;
    s.nextPoll = now + POLL_EVERY_MS;
    try {
      await this.run(ctx, s, now);
    } catch (error) {
      this.d.log.warn({ equipmentId: ctx.equipmentId, err: error instanceof Error ? error.message : String(error) }, "settings sync failed, will retry");
    } finally {
      s.busy = false;
    }
  }

  private slotAndDef(map: RegisterMap, key: string): { slot: WriteSlot; def: MetricDef } | null {
    const slot = map.writes.find((w) => w.key === key);
    const m = map.metrics.find((x) => x.key === key && x.direction === "write") ?? map.metrics.find((x) => x.key === key);
    if (!slot || !m) return null;
    const def: MetricDef = { key: m.key, direction: "write", registers: m.registers, decode: m.decode, enumRef: m.enumRef, valueKind: m.valueKind, validMin: m.validMin, validMax: m.validMax, cadenceSeconds: m.cadence, showForUser: m.showForUser, verified: m.verified };
    return { slot, def };
  }

  private async run(ctx: SettingsContext, s: State, now: number): Promise<void> {
    const eq = ctx.equipmentId;
    if (!s.seeded) {
      s.known = await this.d.store.lastSettings(eq);
      s.seeded = true;
    }
    const rows: SettingRow[] = [];

    // 1. requests that never got an answer
    for (const [id, f] of s.inflight) {
      if (now - f.sentAt < INFLIGHT_TIMEOUT_MS) continue;
      s.inflight.delete(id);
      rows.push(this.failed(s, f.key, f.requested, f.by, "The unit did not answer in time, nothing was changed"));
    }

    // 2. what people are waiting for
    const pending = await this.d.store.pendingWrites(eq);
    const waiting = new Set(pending.map((p) => p.key));
    const refusedIds: number[] = []; // forgotten again if the refusal could not be recorded, so the next round records it
    for (const p of pending) {
      if (s.handled.has(p.id) || [...s.inflight.values()].some((f) => f.key === p.key)) continue;
      if (!ctx.boardAlive) continue; // stays pending; the database forgets it after 10 minutes
      s.handled.add(p.id);
      const refusal = await this.dispatch(ctx, s, p, now);
      if (refusal) {
        rows.push(this.failed(s, p.key, p.value, p.by, refusal));
        refusedIds.push(p.id);
      }
    }
    if (s.handled.size > HANDLED_LIMIT) for (const old of [...s.handled].slice(0, s.handled.size - HANDLED_LIMIT)) s.handled.delete(old);

    // 3. what the unit holds, when it differs from the log (never for a setting somebody is waiting for)
    const inflightKeys = new Set([...s.inflight.values()].map((f) => f.key));
    for (const [key, text] of s.observed) {
      if (waiting.has(key) || inflightKeys.has(key) || s.known.get(key) === text) continue;
      rows.push({ key_name: key, setting_value: text, source: "agent_initial_read" });
    }

    try {
      await this.report(eq, s, rows);
    } catch (error) {
      for (const id of refusedIds) s.handled.delete(id);
      throw error;
    }
  }

  /** Checks a request and sends the command. Returns a plain reason if it was refused. */
  private async dispatch(ctx: SettingsContext, s: State, p: PendingWrite, now: number): Promise<string | null> {
    const found = this.slotAndDef(ctx.map, p.key);
    if (!found) return "This setting cannot be changed from here";
    if (!found.slot.verified && !this.d.allowUnverified) return "This setting has not been verified on the unit yet, so it was not changed";
    const enc = encodeSetting(found.def, found.slot, p.value);
    if (!enc.ok) return enc.reason;

    const id = `w${now.toString(36)}${(++s.seq).toString(36)}`;
    const sent = await this.d.sendCommand(ctx.equipmentId, {
      id,
      type: "write",
      key: p.key,
      reg: found.slot.register,
      mask: found.slot.mask,
      raw: enc.raw,
      issued_at: now,
      expires_at: now + COMMAND_TTL_MS,
    });
    if (!sent) return "The unit could not be reached, nothing was changed";
    s.inflight.set(id, { configId: p.id, key: p.key, requested: p.value, by: p.by, sentAt: now });
    this.d.log.info({ equipmentId: ctx.equipmentId, key: p.key, reg: found.slot.register }, "setting command sent");
    return null;
  }

  /** The unit's answer to a command. Never throws. */
  async onResult(ctx: SettingsContext, body: { id: string; ok: boolean; readback?: number | undefined; error?: string | undefined }): Promise<void> {
    const s = this.state(ctx.equipmentId);
    const f = s.inflight.get(body.id);
    if (!f) return; // late, duplicate or not ours
    s.inflight.delete(body.id);
    const found = this.slotAndDef(ctx.map, f.key);
    const readText = found && body.readback !== undefined ? formatSetting(found.def, found.slot, body.readback) : null;
    let row: SettingRow;
    if (body.ok && readText !== null) {
      row = { key_name: f.key, setting_value: readText, source: "agent_write_ok", ...(s.known.get(f.key) !== undefined ? { previous_value: s.known.get(f.key)! } : {}), ...(f.by ? { written_by: f.by } : {}) };
    } else {
      const why = body.ok ? "The unit's answer could not be read" : (body.error ?? "The unit refused the change");
      row = this.failed(s, f.key, f.requested, f.by, why.slice(0, 200), readText ?? undefined);
    }
    try {
      await this.report(ctx.equipmentId, s, [row]);
    } catch (error) {
      this.d.log.warn({ equipmentId: ctx.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not record a setting result");
    }
  }

  private failed(s: State, key: string, requested: string, by: string | null, reason: string, stillHolds?: string): SettingRow {
    return {
      key_name: key,
      // what the inverter still holds; when that is not known, the request itself (the row's source says it failed)
      setting_value: stillHolds ?? s.known.get(key) ?? s.observed.get(key) ?? requested,
      source: "agent_write_failed",
      previous_value: requested,
      notes: reason.slice(0, 200),
      ...(by ? { written_by: by } : {}),
    };
  }

  private async report(equipmentId: string, s: State, rows: SettingRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += REPORT_BATCH) {
      const chunk = rows.slice(i, i + REPORT_BATCH);
      await this.d.store.reportSettings(equipmentId, chunk);
      for (const r of chunk) s.known.set(r.key_name, r.setting_value);
    }
  }
}
