import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import { ACTIONS, isAction, type ActionName, type MeterValueEntry } from "./schemas.js";
import { normalizeSample } from "./measurands.js";
import { splitSample, summarize, type SiteFigures } from "./split.js";
import type { EvStore } from "./store.js";

/**
 * One charger's connection (OCPP 1.6-J, plan 12.2 and 13.3). Messages are handled one at a time in the order they arrive. Every message is
 * checked against its schema first; a bad one is answered with a CallError and goes no further. The charger is told to send meter values
 * every 30 seconds; the heartbeat interval is 30 seconds too.
 *
 * Frames:  [2, id, action, payload] call   [3, id, payload] result   [4, id, code, description, details] error
 */

export interface ConnLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface ConnInfo {
  equipmentId: string;
  chargePointId: string;
  keyId: string;
  ip: string | null;
}

export interface ConnDeps {
  store: EvStore;
  log: ConnLog;
  now?: () => number;
  /** every frame, for the in-memory log staff can read (see frame-log.ts) */
  frameLog?: (equipmentId: string, direction: "in" | "out", raw: string) => void;
  onClosed?: (c: OcppConnection) => void;
  /** how long a connector may say Available / Finishing while a session is still open before the session is closed (default 90 s) */
  orphanGraceMs?: number;
  /** how long to wait before asking again to stop a charge that went past its target (default 60 s) */
  cutoffRetryMs?: number;
}

/** A session that is running on a connector. */
interface OpenSession {
  transactionId: number;
  sessionId: string;
  meterStartWh: number | null;
  /** the energy asked for (kWh); the charge is stopped when the meter has delivered this much */
  targetKwh: number | null;
  cutoffAttempts: number;
  cutoffLastAt: number;
}

const MAX_CUTOFF_ATTEMPTS = 5;
const PENDING_TARGET_MS = 5 * 60_000;
/** the connector states in which no charge can still be running */
const IDLE_STATES = new Set(["Available", "Finishing"]);

export const HEARTBEAT_INTERVAL_S = 30;
export const METER_INTERVAL_S = 30;
const SAMPLED_DATA = "Energy.Active.Import.Register,Power.Active.Import,Voltage,Current.Import,Current.Offered,SoC,Temperature";
const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 10_000;
const DB_HEARTBEAT_EVERY_MS = 30_000;
const SITE_FIGURES_TTL_MS = 5_000;
const MAX_FIGURES_AGE_S = 60;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 60;
const CALL_TIMEOUT_MS = 15_000;
const MAX_PAST_MS = 7 * 86_400_000;
const MAX_FUTURE_MS = 10 * 60_000;

const hashTag = (tag: string) => createHash("sha256").update(`wt-idtag/v1|${tag}`).digest("hex").slice(0, 32);

type CallError = { code: string; description: string };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class OcppConnection {
  readonly connectedAt: number;
  lastMessageAt: number;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private nextCallId = 1;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private lastDbHeartbeat = 0;
  private firmware: string | null = null;
  private booted = false;
  private rate: number[] = [];
  private closed = false;
  private figures: { at: number; value: (SiteFigures & { age_s: number }) | null } | null = null;
  /** connector -> the transaction running on it, for MeterValues that do not carry a transaction id */
  private open = new Map<number, OpenSession>();
  private sessionIds = new Map<number, string>();
  private lastStatus = new Map<number, string>();
  /** a target asked for with a remote start, waiting for the charge to begin on that connector */
  private pendingTargets = new Map<number, { kwh: number; at: number }>();
  private orphanTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    private readonly d: ConnDeps,
    readonly ws: WebSocket,
    readonly info: ConnInfo,
  ) {
    this.now = d.now ?? Date.now;
    this.connectedAt = this.lastMessageAt = this.now();
  }

  /** A target (kWh) to apply to the charge that begins next on this connector (a remote start with "charge this many units"). */
  setPendingTarget(connector: number, kwh: number): void {
    this.pendingTargets.set(connector, { kwh, at: this.now() });
  }

  clearPendingTarget(connector: number): void {
    this.pendingTargets.delete(connector);
  }

  /** The sessions that were running before this connection (a restart of the server, or the charger reconnecting) are picked up again. */
  private async restore(): Promise<void> {
    try {
      const active = await this.d.store.activeSessions(this.info.equipmentId);
      const newest = new Map<number, (typeof active)[number]>();
      for (const a of active) {
        const prev = newest.get(a.connector);
        if (prev) await this.closeOrphan(a.connector, { transactionId: prev.transactionId, sessionId: prev.id, meterStartWh: prev.meterStartWh, targetKwh: null, cutoffAttempts: 0, cutoffLastAt: 0 }, "superseded");
        newest.set(a.connector, a);
      }
      for (const [connector, a] of newest) {
        this.open.set(connector, { transactionId: a.transactionId, sessionId: a.id, meterStartWh: a.meterStartWh, targetKwh: a.targetKwh, cutoffAttempts: 0, cutoffLastAt: 0 });
        this.sessionIds.set(a.transactionId, a.id);
      }
    } catch (error) {
      this.d.log.warn({ equipmentId: this.info.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not pick up the open sessions");
    }
  }

  start(): void {
    this.queue = this.queue.then(() => this.restore());
    this.ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
      this.queue = this.queue.then(() => this.onFrame(raw)).catch((error) => this.d.log.warn({ equipmentId: this.info.equipmentId, err: error instanceof Error ? error.message : String(error) }, "ocpp frame failed"));
    });
    this.ws.on("pong", () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    });
    this.ws.on("close", () => this.onClose());
    this.ws.on("error", () => undefined); // a socket error is followed by close
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    this.pingTimer.unref();
    void this.record("connected", { ip: this.info.ip, charge_point: this.info.chargePointId });
  }

  /** True if the charger answers a ping within 10 seconds (used to decide whether a second connection may replace this one). */
  alive(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.closed || this.ws.readyState !== 1) return resolve(false);
      const timer = setTimeout(() => {
        this.ws.off("pong", onPong);
        resolve(false);
      }, PONG_WITHIN_MS);
      const onPong = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.ws.once("pong", onPong);
      try {
        this.ws.ping();
      } catch {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  private ping(): void {
    if (this.closed || this.ws.readyState !== 1) return;
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.d.log.warn({ equipmentId: this.info.equipmentId }, "charger did not answer a ping: closing");
        this.ws.terminate();
      }, PONG_WITHIN_MS);
      this.pongTimer.unref();
    }
    try {
      this.ws.ping();
    } catch {
      /* closed meanwhile */
    }
  }

  close(code = 1000, reason = ""): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    for (const t of this.orphanTimers.values()) clearTimeout(t);
    this.orphanTimers.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("the charger disconnected"));
    }
    this.pending.clear();
    void this.record("disconnected", { seconds: Math.round((this.now() - this.connectedAt) / 1000) });
    this.d.onClosed?.(this);
  }

  // ---- sending

  private send(frame: unknown[]): void {
    if (this.ws.readyState !== 1) return;
    const raw = JSON.stringify(frame);
    this.d.frameLog?.(this.info.equipmentId, "out", raw);
    this.ws.send(raw);
  }

  /** Calls the charger (remote start, configuration ...) and waits for its answer. */
  call(action: string, payload: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.ws.readyState !== 1) return reject(new Error("the charger is not connected"));
      const id = `wt-${this.nextCallId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the charger did not answer in time"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send([2, id, action, payload]);
    });
  }

  // ---- receiving

  private tooFast(): boolean {
    const t = this.now();
    this.rate = this.rate.filter((x) => t - x < RATE_WINDOW_MS);
    this.rate.push(t);
    return this.rate.length > RATE_MAX;
  }

  private async onFrame(raw: string): Promise<void> {
    this.lastMessageAt = this.now();
    this.d.frameLog?.(this.info.equipmentId, "in", raw);
    if (this.tooFast()) {
      this.d.log.warn({ equipmentId: this.info.equipmentId }, "charger sends too fast: closing");
      this.close(1008, "too many messages");
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not JSON: nothing to answer to (no message id)
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "number" || typeof msg[1] !== "string" || msg[1].length > 36) return;
    const id = msg[1];

    if (msg[0] === 3 || msg[0] === 4) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg[0] === 3) p.resolve(msg[2]);
      else p.reject(new Error(`the charger answered with an error (${String(msg[2])})`));
      return;
    }
    if (msg[0] !== 2 || typeof msg[2] !== "string") return;

    const action = msg[2];
    if (!isAction(action)) {
      this.send([4, id, "NotImplemented", `${action.slice(0, 40)} is not supported`, {}]);
      return;
    }
    const parsed = ACTIONS[action].safeParse(msg[3] ?? {});
    if (!parsed.success) {
      // names the fields that are wrong, never the values
      this.send([4, id, "FormationViolation", "the message does not match the OCPP 1.6 schema", { fields: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) }]);
      return;
    }
    try {
      const result = await this.handle(action, parsed.data as never);
      this.send([3, id, result]);
    } catch (error) {
      const e = error as CallError & Error;
      if (e && typeof e === "object" && "code" in e && typeof e.code === "string") this.send([4, id, e.code, e.description ?? "", {}]);
      else {
        this.d.log.warn({ equipmentId: this.info.equipmentId, action, err: error instanceof Error ? error.message : String(error) }, "ocpp handler failed");
        this.send([4, id, "InternalError", "the server could not process the message", {}]);
      }
    }
  }

  // ---- time

  /** A time the charger gave, or now (and an event) if it is not a time or is far from now. A transaction started offline may be days old. */
  private when(value: string | undefined, what: string): string {
    const t = value ? Date.parse(value) : NaN;
    const n = this.now();
    if (Number.isFinite(t) && t >= n - MAX_PAST_MS && t <= n + MAX_FUTURE_MS) return new Date(t).toISOString();
    if (value) void this.record("bad_timestamp", { what, value: value.slice(0, 40) });
    return new Date(n).toISOString();
  }

  private async record(kind: string, detail: Record<string, unknown>, sessionId: string | null = null): Promise<void> {
    try {
      await this.d.store.event(this.info.equipmentId, sessionId, new Date(this.now()).toISOString(), kind, detail);
    } catch (error) {
      this.d.log.warn({ equipmentId: this.info.equipmentId, kind, err: error instanceof Error ? error.message : String(error) }, "could not store a charger event");
    }
  }

  /** Tells the status verdict the charger is alive: at most every 30 seconds. */
  private async touch(force = false): Promise<void> {
    if (!force && this.now() - this.lastDbHeartbeat < DB_HEARTBEAT_EVERY_MS) return;
    this.lastDbHeartbeat = this.now();
    try {
      await this.d.store.heartbeat(this.info.equipmentId, this.firmware);
    } catch (error) {
      this.d.log.warn({ equipmentId: this.info.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not store the charger heartbeat");
    }
  }

  private async siteFigures(): Promise<(SiteFigures & { age_s: number }) | null> {
    if (this.figures && this.now() - this.figures.at < SITE_FIGURES_TTL_MS) return this.figures.value;
    let value: (SiteFigures & { age_s: number }) | null;
    try {
      value = await this.d.store.siteFigures(this.info.equipmentId);
    } catch {
      value = null; // the site figures are a bonus: a failure never stops a sample from being stored
    }
    if (value && value.age_s > MAX_FIGURES_AGE_S) value = null; // older than a minute is not "at that moment"
    this.figures = { at: this.now(), value };
    return value;
  }

  // ---- the messages

  private async handle(action: ActionName, p: unknown): Promise<unknown> {
    switch (action) {
      case "BootNotification": {
        const b = p as { chargePointVendor: string; chargePointModel: string; chargePointSerialNumber?: string; firmwareVersion?: string };
        this.firmware = b.firmwareVersion ?? null;
        await this.touch(true);
        await this.record("boot", { vendor: b.chargePointVendor, model: b.chargePointModel, serial: b.chargePointSerialNumber ?? null, firmware: b.firmwareVersion ?? null });
        if (!this.booted) {
          this.booted = true;
          setTimeout(() => void this.configure(), 500).unref();
        }
        return { status: "Accepted", currentTime: new Date(this.now()).toISOString(), interval: HEARTBEAT_INTERVAL_S };
      }
      case "Heartbeat":
        await this.touch();
        return { currentTime: new Date(this.now()).toISOString() };

      case "StatusNotification": {
        const s = p as { connectorId: number; status: string; errorCode: string; info?: string; timestamp?: string };
        const key = `${s.status}/${s.errorCode}`;
        await this.touch();
        if (this.lastStatus.get(s.connectorId) !== key) {
          this.lastStatus.set(s.connectorId, key);
          await this.record("status", { connector: s.connectorId, status: s.status, error: s.errorCode, info: s.info || undefined, at: this.when(s.timestamp, "status") });
        }
        this.watchForMissingStop(s.connectorId, s.status);
        return {};
      }

      case "Authorize": {
        const a = p as { idTag: string };
        await this.record("authorize", { tag: hashTag(a.idTag) });
        return { idTagInfo: { status: "Accepted" } };
      }

      case "StartTransaction": {
        const s = p as { connectorId: number; idTag: string; meterStart: number; timestamp: string };
        await this.touch();
        // a new charge on a connector means the one before it is over, whether or not its stop ever arrived
        const before = this.open.get(s.connectorId);
        if (before) await this.closeOrphan(s.connectorId, before, "superseded");
        const transactionId = await this.d.store.nextTransaction();
        const sessionId = await this.d.store.sessionStart({
          equipmentId: this.info.equipmentId,
          connector: s.connectorId,
          transactionId,
          startedAt: this.when(s.timestamp, "start"),
          meterStartWh: s.meterStart,
          idTagHash: hashTag(s.idTag),
          chargePoint: this.info.chargePointId,
        });
        let targetKwh: number | null = null;
        const wanted = this.pendingTargets.get(s.connectorId);
        this.pendingTargets.delete(s.connectorId);
        if (wanted && this.now() - wanted.at <= PENDING_TARGET_MS) {
          try {
            await this.d.store.sessionSetTarget(sessionId, wanted.kwh);
            targetKwh = wanted.kwh;
          } catch (error) {
            this.d.log.warn({ equipmentId: this.info.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not store the target of a session");
          }
        }
        this.open.set(s.connectorId, { transactionId, sessionId, meterStartWh: s.meterStart, targetKwh, cutoffAttempts: 0, cutoffLastAt: 0 });
        this.sessionIds.set(transactionId, sessionId);
        await this.record("transaction_start", { connector: s.connectorId, transaction: transactionId, meter_start_wh: s.meterStart, ...(targetKwh !== null ? { target_kwh: targetKwh } : {}) }, sessionId);
        return { transactionId, idTagInfo: { status: "Accepted" } };
      }

      case "MeterValues": {
        const m = p as { connectorId: number; transactionId?: number; meterValue: MeterValueEntry[] };
        await this.touch();
        const sessionId = await this.sessionFor(m.connectorId, m.transactionId);
        if (!sessionId) return {}; // meter values outside a transaction are not stored
        for (const entry of m.meterValue) await this.storeSample(sessionId, entry);
        this.checkTarget(m.connectorId, m.transactionId, m.meterValue);
        return {};
      }

      case "StopTransaction": {
        const s = p as { meterStop: number; timestamp: string; transactionId: number; reason?: string };
        await this.touch();
        const sessionId = await this.sessionFor(null, s.transactionId);
        for (const [c, o] of this.open) {
          if (o.transactionId === s.transactionId) {
            this.open.delete(c);
            this.clearOrphanTimer(c);
          }
        }
        this.sessionIds.delete(s.transactionId);
        if (!sessionId) {
          await this.record("stop_without_session", { transaction: s.transactionId });
          return { idTagInfo: { status: "Accepted" } };
        }
        const ref = await this.d.store.sessionByTransaction(this.info.equipmentId, s.transactionId);
        const endedAt = this.when(s.timestamp, "stop");
        const startedAt = ref?.startedAt ?? endedAt;
        const meterStart = ref?.meterStartWh ?? s.meterStop;
        const samples = await this.d.store.sessionSamples(sessionId);
        const summary = summarize(samples, meterStart, s.meterStop, Date.parse(startedAt) / 1000, Date.parse(endedAt) / 1000);
        await this.d.store.sessionStop(sessionId, endedAt, s.meterStop, s.reason ?? "Local", summary);
        await this.record("transaction_stop", { transaction: s.transactionId, reason: s.reason ?? null, energy_kwh: Math.round(s.meterStop - meterStart) / 1000, status: summary.status }, sessionId);
        if (summary.status === "suspect") await this.record("session_suspect", { reason: summary.suspect_reason ?? "" }, sessionId);
        return { idTagInfo: { status: "Accepted" } };
      }

      case "DataTransfer": {
        const t = p as { vendorId: string; messageId?: string };
        await this.record("data_transfer", { vendor: t.vendorId, message: t.messageId ?? null });
        return { status: "UnknownVendorId" };
      }
      case "DiagnosticsStatusNotification":
      case "FirmwareStatusNotification":
        await this.record(action === "DiagnosticsStatusNotification" ? "diagnostics_status" : "firmware_status", { status: (p as { status: string }).status });
        return {};
    }
  }

  // ---- a charge that ended without a stop, and a charge that reached its target

  private clearOrphanTimer(connector: number): void {
    const t = this.orphanTimers.get(connector);
    if (t) clearTimeout(t);
    this.orphanTimers.delete(connector);
  }

  /**
   * A connector that says Available or Finishing cannot still be charging. The charger normally sends its stop first (then this finds
   * nothing open); if it does not, the session is closed after a short wait (the stop may be just behind the status).
   */
  private watchForMissingStop(connector: number, status: string): void {
    if (connector < 1) return;
    if (!IDLE_STATES.has(status)) {
      this.clearOrphanTimer(connector);
      return;
    }
    const session = this.open.get(connector);
    if (!session || this.orphanTimers.has(connector)) return;
    const timer = setTimeout(() => {
      this.orphanTimers.delete(connector);
      // through the same queue as the messages, so it cannot interleave with a stop that has just arrived
      this.queue = this.queue.then(async () => {
        const still = this.open.get(connector);
        if (still && still.transactionId === session.transactionId) await this.closeOrphan(connector, still, `connector ${status}`);
      }).catch((error) => this.d.log.warn({ equipmentId: this.info.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not close a session without a stop"));
    }, this.d.orphanGraceMs ?? 90_000);
    timer.unref();
    this.orphanTimers.set(connector, timer);
  }

  /**
   * Closes a session whose stop never came: it ends at its last sample, with the energy of that sample (or none), status "aborted".
   * If the charger's real stop turns up later it replaces these figures.
   */
  private async closeOrphan(connector: number, o: OpenSession, why: string): Promise<void> {
    this.open.delete(connector);
    this.sessionIds.delete(o.transactionId);
    this.clearOrphanTimer(connector);
    try {
      const samples = await this.d.store.sessionSamples(o.sessionId);
      const last = [...samples].sort((a, b) => a.ts - b.ts).at(-1);
      const ref = await this.d.store.sessionByTransaction(this.info.equipmentId, o.transactionId);
      const meterStart = o.meterStartWh ?? ref?.meterStartWh ?? 0;
      const lastWh = last?.energy_kwh != null ? Math.round(last.energy_kwh * 1000) : null;
      const meterStop = lastWh !== null && lastWh >= meterStart ? lastWh : meterStart;
      const startedAt = ref?.startedAt ?? new Date(this.now()).toISOString();
      const endedAt = last ? new Date(last.ts * 1000).toISOString() : new Date(this.now()).toISOString();
      const summary = summarize(samples, meterStart, meterStop, Date.parse(startedAt) / 1000, Date.parse(endedAt) / 1000);
      if (summary.status === "completed") summary.status = "aborted";
      await this.d.store.sessionStop(o.sessionId, endedAt, meterStop, "MissingStop", summary);
      await this.record("session_closed_without_stop", { transaction: o.transactionId, why, energy_kwh: Math.round(meterStop - meterStart) / 1000 }, o.sessionId);
    } catch (error) {
      this.d.log.warn({ equipmentId: this.info.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not close a session without a stop");
    }
  }

  /** When the meter has delivered the energy asked for, ask the charger to stop (again after a minute, up to five times). */
  private checkTarget(connector: number, transactionId: number | undefined, entries: readonly MeterValueEntry[]): void {
    const o = transactionId !== undefined ? [...this.open.values()].find((x) => x.transactionId === transactionId) : this.open.get(connector);
    if (!o || o.targetKwh === null || o.meterStartWh === null) return;
    let energyKwh: number | undefined;
    for (const e of entries) energyKwh = normalizeSample(e.sampledValue).energy_kwh ?? energyKwh;
    if (energyKwh === undefined) return;
    const consumed = energyKwh - o.meterStartWh / 1000;
    if (consumed < o.targetKwh - 1e-9) return;
    const now = this.now();
    if (o.cutoffAttempts >= MAX_CUTOFF_ATTEMPTS || (o.cutoffAttempts > 0 && now - o.cutoffLastAt < (this.d.cutoffRetryMs ?? 60_000))) return;
    o.cutoffAttempts++;
    o.cutoffLastAt = now;
    if (o.cutoffAttempts === 1) void this.record("target_reached", { transaction: o.transactionId, target_kwh: o.targetKwh, delivered_kwh: Math.round(consumed * 1000) / 1000 }, o.sessionId);
    // not awaited: the charger's answer arrives through the same queue as this message
    void this.call("RemoteStopTransaction", { transactionId: o.transactionId }).then(
      (r) => this.record("target_stop_sent", { transaction: o.transactionId, attempt: o.cutoffAttempts, status: (r as { status?: string })?.status ?? "unknown" }, o.sessionId),
      (e: unknown) => this.record("target_stop_failed", { transaction: o.transactionId, attempt: o.cutoffAttempts, error: e instanceof Error ? e.message.slice(0, 120) : "unknown" }, o.sessionId),
    );
  }

  private async sessionFor(connector: number | null, transactionId: number | undefined): Promise<string | null> {
    if (transactionId !== undefined) {
      const cached = this.sessionIds.get(transactionId);
      if (cached) return cached;
      const ref = await this.d.store.sessionByTransaction(this.info.equipmentId, transactionId);
      if (!ref) return null;
      this.sessionIds.set(transactionId, ref.id);
      return ref.id;
    }
    return connector === null ? null : (this.open.get(connector)?.sessionId ?? null);
  }

  private async storeSample(sessionId: string, entry: MeterValueEntry): Promise<void> {
    const s = normalizeSample(entry.sampledValue);
    const ts = this.when(entry.timestamp, "meter value");
    const row: Record<string, unknown> = { ...s, raw: entry.sampledValue.slice(0, 40) };
    const evW = s.power_kw !== undefined ? s.power_kw * 1000 : null;
    if (evW !== null && evW > 0) {
      const site = await this.siteFigures();
      if (site) {
        row.site_load_w = site.load_w;
        row.pv_w = site.pv_w;
        row.battery_w = site.battery_w;
        row.grid_w = site.grid_w;
        const split = splitSample(evW, site);
        if (split) Object.assign(row, split);
      }
    }
    await this.d.store.sample(sessionId, ts, row);
  }

  // ---- telling the charger how to behave

  private async configure(): Promise<void> {
    for (const [key, value] of [
      ["MeterValueSampleInterval", String(METER_INTERVAL_S)],
      ["MeterValuesSampledData", SAMPLED_DATA],
      ["HeartbeatInterval", String(HEARTBEAT_INTERVAL_S)],
    ] as const) {
      try {
        const r = (await this.call("ChangeConfiguration", { key, value })) as { status?: string };
        if (r?.status !== "Accepted") await this.record("configuration", { key, status: r?.status ?? "unknown" });
      } catch {
        return; // the charger left or does not answer: nothing more to do now
      }
    }
  }
}
