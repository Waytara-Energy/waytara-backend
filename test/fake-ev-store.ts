import type { ActiveSession, ChargerKeyRow, EvStore, SessionRef } from "../src/features/ocpp/store.js";
import type { SessionSummary, SiteFigures, StoredSample } from "../src/features/ocpp/split.js";

export interface FakeSession {
  id: string;
  equipmentId: string;
  connector: number;
  transactionId: number;
  startedAt: string;
  meterStartWh: number;
  idTagHash: string;
  chargePoint: string;
  endedAt: string | null;
  meterStopWh: number | null;
  reason: string | null;
  summary: SessionSummary | null;
  targetKwh?: number | null;
}

/** An in-memory stand-in for the gw_ev_* functions. */
export class FakeEvStore implements EvStore {
  keys: ChargerKeyRow[] = [];
  sessions: FakeSession[] = [];
  samples: { sessionId: string; ts: string; sample: Record<string, unknown> }[] = [];
  events: { equipmentId: string; sessionId: string | null; kind: string; detail: Record<string, unknown> }[] = [];
  heartbeats: { equipmentId: string; firmware: string | null }[] = [];
  figures: (SiteFigures & { age_s: number }) | null = null;
  access_ = new Map<string, "staff" | "owner">();
  failNext = 0;
  private tx = 1000;
  private n = 0;

  private check() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("database down");
    }
  }

  async chargerKeys() {
    return this.keys;
  }
  async nextTransaction() {
    this.check();
    return ++this.tx;
  }
  async sessionStart(a: Parameters<EvStore["sessionStart"]>[0]) {
    this.check();
    const existing = this.sessions.find((s) => s.equipmentId === a.equipmentId && s.transactionId === a.transactionId);
    if (existing) return existing.id;
    const s: FakeSession = { id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`, ...a, endedAt: null, meterStopWh: null, reason: null, summary: null };
    this.sessions.push(s);
    return s.id;
  }
  async sessionByTransaction(equipmentId: string, transactionId: number): Promise<SessionRef | null> {
    const s = this.sessions.find((x) => x.equipmentId === equipmentId && x.transactionId === transactionId);
    return s ? { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, meterStartWh: s.meterStartWh, status: s.endedAt ? "completed" : "active" } : null;
  }
  async sessionSetTarget(sessionId: string, targetKwh: number | null) {
    this.check();
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) throw new Error("unknown session");
    s.targetKwh = targetKwh;
  }
  async activeSessions(equipmentId: string): Promise<ActiveSession[]> {
    this.check();
    return this.sessions
      .filter((s) => s.equipmentId === equipmentId && s.endedAt === null)
      .map((s) => ({ id: s.id, transactionId: s.transactionId, connector: s.connector, startedAt: s.startedAt, meterStartWh: s.meterStartWh, targetKwh: s.targetKwh ?? null }));
  }
  async sample(sessionId: string, ts: string, sample: Record<string, unknown>) {
    this.check();
    const i = this.samples.findIndex((x) => x.sessionId === sessionId && x.ts === ts);
    if (i >= 0) this.samples[i] = { sessionId, ts, sample };
    else this.samples.push({ sessionId, ts, sample });
  }
  async sessionSamples(sessionId: string): Promise<StoredSample[]> {
    return this.samples
      .filter((x) => x.sessionId === sessionId)
      .map((x) => {
        const s = x.sample as Record<string, number | undefined>;
        return {
          ts: Date.parse(x.ts) / 1000,
          power_kw: s.power_kw ?? null,
          current_a: Math.max(s.current_a_l1 ?? 0, s.current_a_l2 ?? 0, s.current_a_l3 ?? 0) || null,
          has_site: s.pv_w !== undefined || s.grid_w !== undefined || s.battery_w !== undefined || s.site_load_w !== undefined,
          solar_w: s.ev_from_solar_w ?? null,
          battery_w: s.ev_from_battery_w ?? null,
          grid_w: s.ev_from_grid_w ?? null,
          energy_kwh: s.energy_kwh ?? null,
        };
      });
  }
  async sessionStop(sessionId: string, endedAt: string, meterStopWh: number, reason: string, summary: SessionSummary) {
    this.check();
    const s = this.sessions.find((x) => x.id === sessionId)!;
    Object.assign(s, { endedAt, meterStopWh, reason, summary });
  }
  async event(equipmentId: string, sessionId: string | null, _ts: string, kind: string, detail: Record<string, unknown>) {
    this.events.push({ equipmentId, sessionId, kind, detail });
  }
  async siteFigures() {
    return this.figures;
  }
  async heartbeat(equipmentId: string, firmware: string | null) {
    this.heartbeats.push({ equipmentId, firmware });
  }
  async access(actor: string, equipmentId: string) {
    return this.access_.get(`${actor}|${equipmentId}`) ?? null;
  }
}
