import type { SiteFigures, StoredSample, SessionSummary } from "./split.js";

/**
 * What the OCPP server needs from storage. The Supabase implementation is db/supabase-ev-store.ts (the gw_ev_* functions); tests use an
 * in-memory one. Every write is keyed so that a repeat (a charger resending after a drop) changes nothing.
 */

export interface ChargerKeyRow {
  equipmentId: string;
  keyId: string;
  /** the charger name the secret was made for (the OCPP identity in the address), if one was given */
  label: string | null;
  ciphertext: Buffer;
  expiresAt: string | null;
}

export interface SessionRef {
  id: string;
  startedAt: string;
  endedAt: string | null;
  meterStartWh: number | null;
  status: string;
}

/** A session that has not ended, as the server needs it to carry on after a restart or a reconnect. */
export interface ActiveSession {
  id: string;
  transactionId: number;
  connector: number;
  startedAt: string;
  meterStartWh: number | null;
  targetKwh: number | null;
}

export interface EvStore {
  chargerKeys(): Promise<ChargerKeyRow[]>;
  nextTransaction(): Promise<number>;
  sessionStart(a: { equipmentId: string; connector: number; transactionId: number; startedAt: string; meterStartWh: number; idTagHash: string; chargePoint: string }): Promise<string>;
  sessionByTransaction(equipmentId: string, transactionId: number): Promise<SessionRef | null>;
  /** the energy asked for at the start; null clears it */
  sessionSetTarget(sessionId: string, targetKwh: number | null): Promise<void>;
  /** the sessions of this charger that have not ended, oldest first */
  activeSessions(equipmentId: string): Promise<ActiveSession[]>;
  sample(sessionId: string, ts: string, sample: Record<string, unknown>): Promise<void>;
  sessionSamples(sessionId: string): Promise<StoredSample[]>;
  sessionStop(sessionId: string, endedAt: string, meterStopWh: number, reason: string, summary: SessionSummary): Promise<void>;
  event(equipmentId: string, sessionId: string | null, ts: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  siteFigures(equipmentId: string): Promise<(SiteFigures & { age_s: number }) | null>;
  /** the charger checked in: feeds the same status verdict the inverter gateways use (online / offline) */
  heartbeat(equipmentId: string, firmware: string | null): Promise<void>;
  /** may this person send commands to this charger, and as whom */
  access(actor: string, equipmentId: string): Promise<"staff" | "owner" | null>;
}
