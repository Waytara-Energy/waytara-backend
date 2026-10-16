import { describe, expect, it } from "vitest";
import { DbError } from "../src/db/gateway-db.js";
import { SupabaseIngestStore, type RpcCaller } from "../src/db/supabase-ingest-store.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const S = 1_792_044_000;

function caller(reply: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const c: RpcCaller = {
    async call(fn, args) {
      calls.push({ fn, args });
      const r = reply(fn, args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { c, calls };
}

const doc = (over: Record<string, unknown> = {}) => ({
  upload_interval_s: 900,
  unreadable_registers: [603, 611],
  mppt_count: 2,
  metrics: [
    { key: "pv1_power_w", direction: "read", registers: [672], decode: { scale: 1 }, enum_ref: null, value_kind: "number", valid_min: 0, valid_max: 12000, cadence_seconds: 10, show_for_user: true, poll_enabled: false, verified: true },
    { key: "grid_mode", direction: "write", registers: [142], decode: null, enum_ref: "grid_mode", value_kind: "enum", valid_min: null, valid_max: null, cadence_seconds: null, show_for_user: true, poll_enabled: false, verified: false },
  ],
  ...over,
});

describe("loadProfile", () => {
  it("turns the catalogue document into the profile the intake uses", async () => {
    const { c, calls } = caller(() => doc());
    const p = (await new SupabaseIngestStore(c).loadProfile(EQ))!;
    expect(calls).toEqual([{ fn: "gw_equipment_profile", args: { p_equipment: EQ } }]);
    expect(p).toMatchObject({ equipmentId: EQ, mpptCount: 2, uploadIntervalS: 900, unreadableRegisters: [603, 611] });
    expect(p.metrics).toHaveLength(2);
    expect(p.metrics[0]).toEqual({
      key: "pv1_power_w", direction: "read", registers: [672], decode: { scale: 1 }, enumRef: null, valueKind: "number",
      validMin: 0, validMax: 12000, cadenceSeconds: 10, showForUser: true, pollEnabled: false, verified: true,
    });
    expect(p.metrics[1]).toMatchObject({ direction: "write", enumRef: "grid_mode", decode: null, showForUser: true });
  });

  it("leaves the PV input count out when the stock record does not say", async () => {
    const p = (await new SupabaseIngestStore(caller(() => doc({ mppt_count: null })).c).loadProfile(EQ))!;
    expect("mpptCount" in p).toBe(false);
  });

  it("answers null for unknown equipment, whether the database says null or not found", async () => {
    expect(await new SupabaseIngestStore(caller(() => null).c).loadProfile(EQ)).toBeNull();
    expect(await new SupabaseIngestStore(caller(() => new DbError("not_found", "x")).c).loadProfile(EQ)).toBeNull();
  });

  it("refuses an answer that is not in the expected shape, and passes outages on", async () => {
    await expect(new SupabaseIngestStore(caller(() => doc({ upload_interval_s: 5 })).c).loadProfile(EQ)).rejects.toMatchObject({ kind: "invalid" });
    await expect(new SupabaseIngestStore(caller(() => doc({ metrics: [{ key: "x" }] })).c).loadProfile(EQ)).rejects.toMatchObject({ kind: "invalid" });
    await expect(new SupabaseIngestStore(caller(() => new DbError("unavailable", "down")).c).loadProfile(EQ)).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("storeMap", () => {
  it("sends the map and returns its version", async () => {
    const { c, calls } = caller(() => 3);
    expect(await new SupabaseIngestStore(c).storeMap(EQ, "abcdef0123456789", { ver: 1 })).toBe(3);
    expect(calls[0]).toEqual({ fn: "gw_store_map", args: { p_equipment: EQ, p_hash: "abcdef0123456789", p_body: { ver: 1 } } });
  });

  it("refuses a version that is not a whole number", async () => {
    await expect(new SupabaseIngestStore(caller(() => "1").c).storeMap(EQ, "abcdef0123456789", {})).rejects.toMatchObject({ kind: "invalid" });
    await expect(new SupabaseIngestStore(caller(() => 0).c).storeMap(EQ, "abcdef0123456789", {})).rejects.toMatchObject({ kind: "invalid" });
  });

  it("does not hide an unknown equipment as if it were an outage", async () => {
    await expect(new SupabaseIngestStore(caller(() => new DbError("not_found", "x")).c).storeMap(EQ, "abcdef0123456789", {})).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("writeSummaries", () => {
  it("sends finished buckets, the open bucket and the latest values in the shape the function reads", async () => {
    const { c, calls } = caller(() => ({ buckets_written: 1 }));
    await new SupabaseIngestStore(c).writeSummaries({
      equipmentId: EQ,
      buckets: [{ key: "pv1_power_w", start: S, wsum: 90_000, covered: 900, min: 100, max: 100, last: 100, n: 180 }],
      open: [{ key: "battery_power_w", bucket: { start: S + 900, wsum: -600, covered: 10, min: -60, max: -60, last: -60, pos: 0, neg: 600, n: 2 } }],
      latest: [{ key: "pv1_power_w", value: 100, ts: S + 1795 }],
    });
    expect(calls).toEqual([
      {
        fn: "gw_ingest_summaries",
        args: {
          p_equipment: EQ,
          p_buckets: [{ k: "pv1_power_w", b: new Date(S * 1000).toISOString(), w: 90_000, c: 900, mn: 100, mx: 100, l: 100, n: 180 }],
          p_open: [{ k: "battery_power_w", b: new Date((S + 900) * 1000).toISOString(), w: -600, c: 10, mn: -60, mx: -60, l: -60, pw: 0, nw: 600, n: 2 }],
          p_latest: [{ k: "pv1_power_w", v: 100, t: S + 1795 }],
        },
      },
    ]);
  });

  it("lets a failure reach the caller, which keeps the buckets and retries", async () => {
    const store = new SupabaseIngestStore(caller(() => new DbError("unavailable", "down")).c);
    await expect(store.writeSummaries({ equipmentId: EQ, buckets: [], open: [], latest: [] })).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("reportHeartbeat", () => {
  it("sends what the board said, with nulls for what it did not", async () => {
    const { c, calls } = caller(() => null);
    const store = new SupabaseIngestStore(c);
    await store.reportHeartbeat({ equipmentId: EQ, receivedAt: S, boot: 5, uptimeS: 42, inverterOnline: false, lastModbusOkAgeS: 31, fwVersion: "2.0.1", mapVer: 2, resetReason: "power_on", clockOffsetS: -1.5, uploadIntervalS: 900 });
    await store.reportHeartbeat({ equipmentId: EQ, receivedAt: S, boot: 5, uptimeS: 52 });
    expect(calls[0]).toEqual({
      fn: "gw_report_heartbeat",
      args: { p_equipment: EQ, p_uptime_s: 42, p_inverter_online: false, p_last_modbus_ok_age_s: 31, p_fw_version: "2.0.1", p_map_version: 2, p_reset_reason: "power_on", p_clock_offset_s: -1.5, p_upload_interval_s: 900, p_heartbeat_s: 10 },
    });
    expect(calls[1]!.args).toEqual({
      p_equipment: EQ, p_uptime_s: 52, p_inverter_online: null, p_last_modbus_ok_age_s: null, p_fw_version: null, p_map_version: null, p_reset_reason: null, p_clock_offset_s: null, p_upload_interval_s: null, p_heartbeat_s: 10,
    });
  });
});

describe("settings write-back calls", () => {
  it("lists what is waiting, checking the shape of the answer", async () => {
    const { c, calls } = caller(() => [{ id: 7, key: "battery_shutdown_soc_pct", value: "20", by: "c1000000-0000-4000-8000-000000000001" }, { id: 8, key: "x", value: "1", by: null }]);
    const p = await new SupabaseIngestStore(c).pendingWrites(EQ);
    expect(calls).toEqual([{ fn: "gw_pending_writes", args: { p_equipment: EQ } }]);
    expect(p).toEqual([{ id: 7, key: "battery_shutdown_soc_pct", value: "20", by: "c1000000-0000-4000-8000-000000000001" }, { id: 8, key: "x", value: "1", by: null }]);
    await expect(new SupabaseIngestStore(caller(() => ({ not: "a list" })).c).pendingWrites(EQ)).rejects.toBeInstanceOf(DbError);
  });

  it("sends the rows with nulls for what is missing, and sends nothing for an empty list", async () => {
    const { c, calls } = caller(() => 2);
    const store = new SupabaseIngestStore(c);
    expect(await store.reportSettings(EQ, [])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await store.reportSettings(EQ, [{ key_name: "k", setting_value: "5", source: "agent_write_failed", previous_value: "6", notes: "why" }, { key_name: "j", setting_value: "1", source: "agent_initial_read" }])).toBe(2);
    expect(calls[0]).toEqual({
      fn: "gw_report_settings",
      args: { p_equipment: EQ, p_rows: [
        { key_name: "k", setting_value: "5", source: "agent_write_failed", previous_value: "6", notes: "why", written_by: null },
        { key_name: "j", setting_value: "1", source: "agent_initial_read", previous_value: null, notes: null, written_by: null },
      ] },
    });
  });

  it("reads the last value of each setting into a map", async () => {
    const { c } = caller(() => [{ key: "a", value: "1", source: "agent_initial_read", id: 3 }, { key: "b", value: null }]);
    const m = await new SupabaseIngestStore(c).lastSettings(EQ);
    expect([...m]).toEqual([["a", "1"]]);
  });
});
