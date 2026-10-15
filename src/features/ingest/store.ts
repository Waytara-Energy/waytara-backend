import type { MetricDef } from "../../core/decode.js";
import type { BucketStats, ClosedBucket } from "../../core/rollup.js";

/**
 * What the data intake needs from storage. The Supabase implementation is db/supabase-ingest-store.ts; tests use an in-memory stand-in. Writes REPLACE: sending the same bucket again changes nothing, so a retry or a late reading is safe.
 */

export interface EquipmentProfile {
  equipmentId: string;
  /** the catalogue rows of this equipment (equipment_metrics joined with the template) */
  metrics: MetricDef[];
  /** PV inputs from the stock record, if known */
  mpptCount?: number;
  /** how often values are sent to the database, in seconds (default 900) */
  uploadIntervalS: number;
  /** registers the 10 Sep sweep found silent: a request is never extended across them */
  unreadableRegisters?: number[];
}

export interface SummaryWrite {
  equipmentId: string;
  buckets: ClosedBucket[];
  /** the unfinished bucket of each value as it stands at the time of writing */
  open: { key: string; bucket: BucketStats }[];
  /** the newest decoded value of each key since the last write; ts is seconds since 1970 */
  latest: { key: string; value: number; ts: number }[];
}

export interface HeartbeatReport {
  equipmentId: string;
  /** seconds since 1970, server clock */
  receivedAt: number;
  boot: number;
  uptimeS: number;
  inverterOnline?: boolean;
  lastModbusOkAgeS?: number;
  fwVersion?: string;
  mapVer?: number;
  rssi?: number;
  queueFrames?: number;
  resetReason?: string;
  /** device clock minus server clock, seconds; only when the device says its clock is valid */
  clockOffsetS?: number;
  /** how often summaries are written for this unit, seconds */
  uploadIntervalS?: number;
}

export interface IngestStore {
  loadProfile(equipmentId: string): Promise<EquipmentProfile | null>;
  /** Stores a register map (idempotent by hash) and returns its version number for this equipment. */
  storeMap(equipmentId: string, hash: string, body: unknown): Promise<number>;
  writeSummaries(w: SummaryWrite): Promise<void>;
  reportHeartbeat(h: HeartbeatReport): Promise<void>;
}
