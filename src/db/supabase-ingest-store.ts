import { z } from "zod";
import type { BucketStats, ClosedBucket } from "../core/rollup.js";
import type { MetricDef } from "../core/decode.js";
import type { EquipmentProfile, HeartbeatReport, IngestStore, SummaryWrite } from "../features/ingest/store.js";
import type { LiveStore, LiveTiming } from "../features/ingest/live.js";
import type { PendingWrite, SettingRow, SettingsStore } from "../features/ingest/settings.js";
import { DbError } from "./gateway-db.js";

const pendingDoc = z.array(z.object({ id: z.number().int(), key: z.string().min(1).max(120), value: z.string().max(200), by: z.string().uuid().nullable().optional() }));
const lastDoc = z.array(z.object({ key: z.string().min(1).max(120), value: z.string().max(200).nullable() }));

/**
 * The data intake's storage: calls the waytara.gw_* functions of migration 20261015020000 as the backend's service user.
 * Everything that comes back is checked; a malformed answer is a database problem, not something to pass on.
 */

/** The part of SupabaseGatewayDb this store needs (so tests can stand in for it). */
export interface RpcCaller {
  call(fn: string, args: Record<string, unknown>): Promise<unknown>;
}

const num = z.number().finite();
const metricRow = z.object({
  key: z.string().min(1).max(120),
  direction: z.enum(["read", "write", "command"]),
  registers: z.array(z.number().int().min(0).max(0xffff)).max(8),
  decode: z.record(z.string(), z.unknown()).nullable(),
  enum_ref: z.string().nullable().optional(),
  value_kind: z.string().nullable().optional(),
  valid_min: num.nullable().optional(),
  valid_max: num.nullable().optional(),
  cadence_seconds: z.number().int().nullable().optional(),
  show_for_user: z.boolean().nullable().optional(),
  poll_enabled: z.boolean().nullable().optional(),
  verified: z.boolean().nullable().optional(),
  label: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});
const profileDoc = z.object({
  upload_interval_s: z.number().int().min(60).max(3600),
  unreadable_registers: z.array(z.number().int().min(0).max(0xffff)),
  mppt_count: z.number().int().min(0).max(64).nullable(),
  metrics: z.array(metricRow).max(2000),
});

const wireBucket = (b: BucketStats) => ({
  b: new Date(b.start * 1000).toISOString(),
  w: b.wsum,
  c: b.covered,
  mn: b.min,
  mx: b.max,
  l: b.last,
  ...(b.pos !== undefined ? { pw: b.pos } : {}),
  ...(b.neg !== undefined ? { nw: b.neg } : {}),
  n: b.n,
});

export class SupabaseIngestStore implements IngestStore, SettingsStore, LiveStore {
  constructor(private readonly db: RpcCaller) {}

  async loadProfile(equipmentId: string): Promise<EquipmentProfile | null> {
    const data = await this.guard("gw_equipment_profile", { p_equipment: equipmentId });
    if (data === null || data === undefined) return null;
    const parsed = profileDoc.safeParse(data);
    if (!parsed.success) throw new DbError("invalid", "the catalogue of this equipment is not in the expected shape");
    const p = parsed.data;
    const metrics: MetricDef[] = p.metrics.map((m) => ({
      key: m.key,
      direction: m.direction,
      registers: m.registers,
      decode: (m.decode as MetricDef["decode"]) ?? null,
      enumRef: m.enum_ref ?? null,
      valueKind: m.value_kind ?? null,
      validMin: m.valid_min ?? null,
      validMax: m.valid_max ?? null,
      cadenceSeconds: m.cadence_seconds ?? null,
      showForUser: m.show_for_user ?? false,
      pollEnabled: m.poll_enabled ?? false,
      verified: m.verified ?? false,
    }));
    const labels: NonNullable<EquipmentProfile["labels"]> = {};
    for (const m of p.metrics) if (m.direction === "read") labels[m.key] = { label: m.label ?? m.key, unit: m.unit ?? null, category: m.category ?? null };
    return {
      equipmentId,
      metrics,
      labels,
      ...(p.mppt_count !== null ? { mpptCount: p.mppt_count } : {}),
      uploadIntervalS: p.upload_interval_s,
      unreadableRegisters: p.unreadable_registers,
    };
  }

  async storeMap(equipmentId: string, hash: string, body: unknown): Promise<number> {
    const v = await this.guard("gw_store_map", { p_equipment: equipmentId, p_hash: hash, p_body: body });
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new DbError("invalid", "unexpected register map version from the database");
    return v;
  }

  async writeSummaries(w: SummaryWrite): Promise<void> {
    await this.guard("gw_ingest_summaries", {
      p_equipment: w.equipmentId,
      p_buckets: w.buckets.map((b: ClosedBucket) => ({ k: b.key, ...wireBucket(b) })),
      p_open: w.open.map((o) => ({ k: o.key, ...wireBucket(o.bucket) })),
      p_latest: w.latest.map((l) => ({ k: l.key, v: l.value, t: l.ts })),
    });
  }

  async reportHeartbeat(h: HeartbeatReport): Promise<void> {
    await this.guard("gw_report_heartbeat", {
      p_equipment: h.equipmentId,
      p_uptime_s: h.uptimeS,
      p_inverter_online: h.inverterOnline ?? null,
      p_last_modbus_ok_age_s: h.lastModbusOkAgeS ?? null,
      p_fw_version: h.fwVersion ?? null,
      p_map_version: h.mapVer ?? null,
      p_reset_reason: h.resetReason ?? null,
      p_clock_offset_s: h.clockOffsetS ?? null,
      p_upload_interval_s: h.uploadIntervalS ?? null,
      p_heartbeat_s: 10,
    });
  }

  // ---- settings write-back (migration 20261016020000)

  async pendingWrites(equipmentId: string): Promise<PendingWrite[]> {
    const data = await this.guard("gw_pending_writes", { p_equipment: equipmentId });
    const parsed = pendingDoc.safeParse(data);
    if (!parsed.success) throw new DbError("invalid", "the pending settings are not in the expected shape");
    return parsed.data.map((p) => ({ id: p.id, key: p.key, value: p.value, by: p.by ?? null }));
  }

  async reportSettings(equipmentId: string, rows: SettingRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const n = await this.guard("gw_report_settings", {
      p_equipment: equipmentId,
      p_rows: rows.map((r) => ({
        key_name: r.key_name,
        setting_value: r.setting_value,
        source: r.source,
        previous_value: r.previous_value ?? null,
        notes: r.notes ?? null,
        written_by: r.written_by ?? null,
      })),
    });
    return typeof n === "number" ? n : 0;
  }

  async lastSettings(equipmentId: string): Promise<Map<string, string>> {
    const data = await this.guard("gw_last_settings", { p_equipment: equipmentId });
    const parsed = lastDoc.safeParse(data);
    if (!parsed.success) throw new DbError("invalid", "the last settings are not in the expected shape");
    const out = new Map<string, string>();
    for (const r of parsed.data) if (r.value !== null) out.set(r.key, r.value);
    return out;
  }

  // ---- Go Live (migration 20261016030000)

  async liveActive(equipmentId: string): Promise<boolean> {
    return (await this.guard("gw_live_active", { p_equipment: equipmentId })) === true;
  }

  async liveUntil(equipmentId: string): Promise<number | null> {
    const r = await this.guard("gw_live_until", { p_equipment: equipmentId });
    const ms = typeof r === "string" ? Date.parse(r) : NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  async recordLiveTiming(equipmentId: string, t: LiveTiming): Promise<void> {
    await this.guard("gw_record_live_timing", {
      p_equipment: equipmentId,
      p_started_at: new Date(t.startedAt).toISOString(),
      p_request_to_command_ms: t.requestToCommandMs,
      p_command_to_first_frame_ms: t.commandToFirstFrameMs,
      p_first_frame_to_tick_ms: t.firstFrameToTickMs,
      p_request_to_first_tick_ms: t.requestToFirstTickMs,
      p_ticks: t.ticks,
      p_avg_gap_ms: t.avgGapMs,
      p_max_gap_ms: t.maxGapMs,
    });
  }

  async liveTick(equipmentId: string, tMs: number, values: Record<string, number>): Promise<boolean> {
    return (await this.guard("gw_live_tick", { p_equipment: equipmentId, p_t: Math.round(tMs), p_v: values })) === true;
  }

  /** An unknown equipment is not an outage: the caller gets the plain answer for it where there is one. */
  private async guard(fn: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.db.call(fn, args);
    } catch (error) {
      if (error instanceof DbError && error.kind === "not_found" && fn === "gw_equipment_profile") return null;
      throw error;
    }
  }
}
