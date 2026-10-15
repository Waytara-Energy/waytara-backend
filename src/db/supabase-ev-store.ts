import { DbError } from "./gateway-db.js";
import type { RpcCaller } from "./supabase-ingest-store.js";
import type { ChargerKeyRow, EvStore, SessionRef } from "../features/ocpp/store.js";
import type { SessionSummary, SiteFigures, StoredSample } from "../features/ocpp/split.js";

/** The OCPP server's storage: the gw_ev_* functions of migration 20261016000000_ev_ocpp.sql, called as the backend's service user. */

const toHex = (b: Buffer) => `\\x${b.toString("hex")}`;
const fromHex = (v: unknown): Buffer => {
  if (typeof v !== "string" || !v.startsWith("\\x")) throw new DbError("invalid", "unexpected bytes from the database");
  return Buffer.from(v.slice(2), "hex");
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const rows = (data: unknown): Record<string, unknown>[] => (Array.isArray(data) ? (data as Record<string, unknown>[]) : data == null ? [] : [data as Record<string, unknown>]);

export class SupabaseEvStore implements EvStore {
  constructor(private readonly db: RpcCaller) {}

  async chargerKeys(): Promise<ChargerKeyRow[]> {
    return rows(await this.db.call("gw_charger_keys", {})).map((r) => ({
      equipmentId: String(r.equipment_id),
      keyId: String(r.key_id),
      label: typeof r.label === "string" ? r.label : null,
      ciphertext: fromHex(r.key_ciphertext),
      expiresAt: typeof r.expires_at === "string" ? r.expires_at : null,
    }));
  }

  async nextTransaction(): Promise<number> {
    const v = await this.db.call("gw_ev_next_transaction", {});
    const n = numOrNull(v);
    if (n === null || !Number.isInteger(n)) throw new DbError("invalid", "unexpected transaction number from the database");
    return n;
  }

  async sessionStart(a: Parameters<EvStore["sessionStart"]>[0]): Promise<string> {
    const id = await this.db.call("gw_ev_session_start", {
      p_equipment: a.equipmentId,
      p_connector: a.connector,
      p_transaction: a.transactionId,
      p_started_at: a.startedAt,
      p_meter_start_wh: a.meterStartWh,
      p_id_tag_hash: a.idTagHash,
      p_charge_point: a.chargePoint,
      p_source: "ocpp",
    });
    if (typeof id !== "string") throw new DbError("invalid", "unexpected session id from the database");
    return id;
  }

  async sessionByTransaction(equipmentId: string, transactionId: number): Promise<SessionRef | null> {
    const r = rows(await this.db.call("gw_ev_session_by_transaction", { p_equipment: equipmentId, p_transaction: transactionId }))[0];
    if (!r) return null;
    return {
      id: String(r.id),
      startedAt: String(r.started_at),
      endedAt: typeof r.ended_at === "string" ? r.ended_at : null,
      meterStartWh: numOrNull(r.meter_start_wh),
      status: String(r.status),
    };
  }

  async sample(sessionId: string, ts: string, sample: Record<string, unknown>): Promise<void> {
    await this.db.call("gw_ev_sample", { p_session: sessionId, p_ts: ts, p_sample: sample });
  }

  async sessionSamples(sessionId: string): Promise<StoredSample[]> {
    const data = await this.db.call("gw_ev_session_samples", { p_session: sessionId });
    return rows(data).map((r) => ({
      ts: Number(r.ts),
      power_kw: numOrNull(r.power_kw),
      current_a: numOrNull(r.current_a),
      has_site: r.has_site === true,
      solar_w: numOrNull(r.solar_w),
      battery_w: numOrNull(r.battery_w),
      grid_w: numOrNull(r.grid_w),
    }));
  }

  async sessionStop(sessionId: string, endedAt: string, meterStopWh: number, reason: string, summary: SessionSummary): Promise<void> {
    await this.db.call("gw_ev_session_stop", { p_session: sessionId, p_ended_at: endedAt, p_meter_stop_wh: meterStopWh, p_reason: reason, p_summary: summary });
  }

  async event(equipmentId: string, sessionId: string | null, ts: string, kind: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.call("gw_ev_event", { p_equipment: equipmentId, p_session: sessionId, p_ts: ts, p_kind: kind, p_detail: detail });
  }

  async siteFigures(equipmentId: string): Promise<(SiteFigures & { age_s: number }) | null> {
    const v = (await this.db.call("gw_ev_site_figures", { p_equipment: equipmentId })) as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return null;
    return { pv_w: numOrNull(v.pv_w), battery_w: numOrNull(v.battery_w), grid_w: numOrNull(v.grid_w), load_w: numOrNull(v.load_w), age_s: numOrNull(v.age_s) ?? Infinity };
  }

  async heartbeat(equipmentId: string, firmware: string | null): Promise<void> {
    await this.db.call("gw_report_heartbeat", { p_equipment: equipmentId, p_fw_version: firmware, p_heartbeat_s: 30 });
  }

  async access(actor: string, equipmentId: string): Promise<"staff" | "owner" | null> {
    const v = await this.db.call("gw_ev_access", { p_actor: actor, p_equipment: equipmentId });
    return v === "staff" || v === "owner" ? v : null;
  }
}

void toHex; // reserved for writes of bytes; the charger secrets are only read
