import { decodeMetric, type MetricDef } from "../../core/decode.js";
import { buildRegisterMap, type RegisterMap } from "../../core/register-map.js";
import { RollupEngine, bucketStartOf } from "../../core/rollup.js";
import { ReplayGuard, SealError, openWithAnyKey, seal } from "../../core/seal.js";
import { dnTopic, upTopic } from "../broker/topics.js";
import type { KeyCache } from "../broker/key-cache.js";
import { dataBody, evtBody, hbBody, type DataBody } from "./schemas.js";
import type { EquipmentProfile, IngestStore } from "./store.js";

/**
 * Receives what boards send (sealed batches, heartbeats, events), turns raw register words into values, feeds the 15-minute engine,
 * writes finished buckets and the latest values to storage every upload interval, and tells the board what is safely stored.
 *
 * Acknowledgements: a board keeps its readings until told they are stored. The backend says "stored" only for readings older than
 * the last finished and written bucket by two minutes (ACK_LAG_S), so if the backend restarts, the board resends the end of the
 * previous bucket and the first bucket after the restart is rebuilt exactly, including what the previous reading held into it.
 */

export interface IngestLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface IngestDeps {
  keys: KeyCache;
  store: IngestStore;
  /** publishes a sealed message to a board (the broker); retain=true for the register map */
  publish: (equipmentId: string, topic: string, payload: Buffer, retain: boolean) => Promise<void>;
  log: IngestLog;
  now?: () => number;
  /** called (best effort) when a sealed message does not authenticate */
  onRejected?: (equipmentId: string, reason: string) => void;
}

const ACK_LAG_S = 120;
const FRAME_MAX_AGE_MS = 36 * 3600_000;
const FRAME_MAX_FUTURE_MS = 10 * 60_000;
// A write per check-in (they come every 10 s): the database judges "offline" after three missed check-ins, so writing less often
// than that would make a healthy unit look offline.
const HEARTBEAT_WRITE_EVERY_MS = 9_000;
const MAP_REBUILD_AFTER_MS = 10 * 60_000;
const RETRY_AFTER_FAILED_WRITE_MS = 30_000;
const EPOCH_2026 = Date.UTC(2026, 0, 1) / 1000;
const SEEN_LIMIT = 5000;

interface Session {
  equipmentId: string;
  profile: EquipmentProfile;
  map: RegisterMap;
  mapVersion: number;
  mapBuiltAt: number;
  readDefs: MetricDef[];
  engine: RollupEngine;
  guard: ReplayGuard;
  latest: Map<string, { value: number; ts: number }>;
  pending: Map<number, { seq: number; t: number }[]>;
  seen: Set<string>;
  lastAck: Map<number, number>;
  flushedBoundary: number;
  nextFlushAt: number;
  lastKeyRef: string | undefined;
  lastHbWrite: number;
  lastHbInverterOnline: boolean | undefined;
  lastHbMapVer: number | undefined;
  lastMapPublish: number;
  lastBoot: number | undefined;
  downCounter: number;
  stats: Record<"batches" | "frames" | "duplicates" | "droppedTime" | "outOfRange" | "undecodable" | "rejected" | "flushes" | "flushFailures", number>;
}

const emptyStats = (): Session["stats"] => ({ batches: 0, frames: 0, duplicates: 0, droppedTime: 0, outOfRange: 0, undecodable: 0, rejected: 0, flushes: 0, flushFailures: 0 });

export class IngestService {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<Session | null>>();
  private readonly shapeWarned = new Map<string, number>();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly d: IngestDeps) {
    this.now = d.now ?? Date.now;
  }

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.tick(this.now()), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- entry points from the broker

  /** A message a board published on up/<name>. Never throws. */
  async handleUp(equipmentId: string, name: string, payload: Buffer): Promise<void> {
    try {
      if (name === "state") {
        this.d.log.info({ equipmentId, state: payload.toString("utf8").slice(0, 16) }, "board presence");
        return;
      }
      if (name !== "data" && name !== "hb" && name !== "evt") return;
      const s = await this.session(equipmentId);
      if (!s) return;
      const opened = await this.open(s, name, payload);
      if (!opened) return;
      if (name === "data") await this.onData(s, opened.body);
      else if (name === "hb") await this.onHeartbeat(s, opened.body);
      else await this.onEvent(s, opened.body);
    } catch (error) {
      this.d.log.warn({ equipmentId, name, err: error instanceof Error ? error.message : String(error) }, "up message failed");
    }
  }

  /** A board logged in: make sure it has the current register map. */
  async handleReady(equipmentId: string): Promise<void> {
    try {
      const s = await this.session(equipmentId);
      if (s) await this.publishMap(s, true);
    } catch (error) {
      this.d.log.warn({ equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not prepare the register map");
    }
  }

  // ---- sessions

  private session(equipmentId: string): Promise<Session | null> {
    const existing = this.sessions.get(equipmentId);
    if (existing && this.now() - existing.mapBuiltAt < MAP_REBUILD_AFTER_MS) return Promise.resolve(existing);
    const pending = this.opening.get(equipmentId);
    if (pending) return pending;
    const p = this.create(equipmentId, existing).finally(() => this.opening.delete(equipmentId));
    this.opening.set(equipmentId, p);
    return p;
  }

  private async create(equipmentId: string, existing?: Session): Promise<Session | null> {
    const profile = await this.d.store.loadProfile(equipmentId);
    if (!profile) {
      this.d.log.warn({ equipmentId }, "no catalogue for this equipment: its data is ignored");
      return existing ?? null;
    }
    const unreadable = new Set(profile.unreadableRegisters ?? []);
    const known = new Set(profile.metrics.filter((m) => m.direction === "read").flatMap((m) => m.registers));
    const map = buildRegisterMap(profile.metrics, { ...(profile.mpptCount !== undefined ? { mpptCount: profile.mpptCount } : {}), isReadable: (r) => known.has(r) && !unreadable.has(r) });
    const version = existing && existing.map.hash === map.hash ? existing.mapVersion : await this.d.store.storeMap(equipmentId, map.hash, mapBody(map, 0));
    const readDefs: MetricDef[] = map.metrics
      .filter((m) => m.direction === "read")
      .map((m) => ({ key: m.key, direction: "read", registers: m.registers, decode: m.decode, enumRef: m.enumRef, valueKind: m.valueKind, validMin: m.validMin, validMax: m.validMax, cadenceSeconds: m.cadence, showForUser: m.showForUser, verified: m.verified }));

    if (existing) {
      Object.assign(existing, { profile, map, mapVersion: version, mapBuiltAt: this.now(), readDefs });
      return existing;
    }
    const nowS = this.now() / 1000;
    const s: Session = {
      equipmentId, profile, map, mapVersion: version, mapBuiltAt: this.now(), readDefs,
      engine: new RollupEngine(), guard: new ReplayGuard(), latest: new Map(), pending: new Map(), seen: new Set(), lastAck: new Map(),
      flushedBoundary: bucketStartOf(nowS), nextFlushAt: this.nextFlush(profile.uploadIntervalS, nowS),
      lastKeyRef: undefined, lastHbWrite: 0, lastHbInverterOnline: undefined, lastHbMapVer: undefined, lastMapPublish: 0, lastBoot: undefined, downCounter: 0, stats: emptyStats(),
    };
    this.sessions.set(equipmentId, s);
    return s;
  }

  private nextFlush(intervalS: number, nowS: number): number {
    const iv = Math.min(3600, Math.max(60, intervalS || 900));
    return (Math.floor(nowS / iv) + 1) * iv * 1000 + 3000;
  }

  // ---- opening sealed messages

  private async open(s: Session, name: "data" | "hb" | "evt", payload: Buffer): Promise<{ body: unknown } | null> {
    const keys = await this.d.keys.get(s.equipmentId);
    if (keys.length === 0) return null;
    try {
      const opened = openWithAnyKey(payload, keys.map((k) => ({ id: k.keyId, key: k.key })), { equipmentId: s.equipmentId, direction: "up", topic: upTopic(s.equipmentId, name) });
      s.guard.accept(opened.counter);
      s.lastKeyRef = opened.keyRef;
      return { body: opened.body };
    } catch (error) {
      s.stats.rejected++;
      const reason = error instanceof SealError ? error.reason : "error";
      this.d.log.warn({ equipmentId: s.equipmentId, name, reason }, "sealed message refused");
      this.d.onRejected?.(s.equipmentId, reason);
      return null;
    }
  }

  // ---- data

  private async onData(s: Session, raw: unknown): Promise<void> {
    const parsed = dataBody.safeParse(raw);
    if (!parsed.success) {
      return this.wrongShape(s, "data batch", parsed.error.issues);
    }
    const body: DataBody = parsed.data;
    s.stats.batches++;
    s.lastBoot = body.boot;
    const nowMs = this.now();
    let pendingForBoot = s.pending.get(body.boot);
    if (!pendingForBoot) s.pending.set(body.boot, (pendingForBoot = []));

    for (const f of body.frames) {
      const id = `${body.boot}:${f.seq}`;
      if (s.seen.has(id)) {
        s.stats.duplicates++;
        continue;
      }
      s.seen.add(id);
      pendingForBoot.push({ seq: f.seq, t: f.t });
      if (f.t > nowMs + FRAME_MAX_FUTURE_MS || f.t < nowMs - FRAME_MAX_AGE_MS) {
        s.stats.droppedTime++;
        continue;
      }
      s.stats.frames++;

      const words = new Map<number, number>();
      for (const [start, ws] of f.blocks) ws.forEach((w, i) => words.set(start + i, w));
      const tSec = f.t / 1000;
      for (const def of s.readDefs) {
        if (!def.registers.every((r) => words.has(r))) continue;
        const r = decodeMetric(def, words);
        if (!r.ok) {
          s.stats.undecodable++;
          continue;
        }
        if (typeof r.value !== "number") continue;
        if (!r.inRange) {
          s.stats.outOfRange++;
          continue; // kept out of summaries and latest values: no false data
        }
        s.engine.add(def.key, tSec, r.value, def.cadenceSeconds);
        const prev = s.latest.get(def.key);
        if (!prev || tSec >= prev.ts) s.latest.set(def.key, { value: r.value, ts: tSec });
      }
    }
    pendingForBoot.sort((a, b) => a.seq - b.seq);
    if (s.seen.size > SEEN_LIMIT) for (const old of [...s.seen].slice(0, s.seen.size - SEEN_LIMIT)) s.seen.delete(old);
  }

  // ---- heartbeat and events

  /** A sealed message that opened fine but is not in the agreed shape: a firmware bug. Said once a minute per board and kind. */
  private wrongShape(s: Session, what: string, issues: readonly { path: PropertyKey[] }[]): void {
    const k = `${s.equipmentId}|${what}`;
    if (this.now() - (this.shapeWarned.get(k) ?? 0) < 60_000) return;
    this.shapeWarned.set(k, this.now());
    this.d.log.warn({ equipmentId: s.equipmentId, problems: issues.slice(0, 3).map((i) => i.path.map(String).join(".")) }, `${what} has the wrong shape`);
  }

  private async onHeartbeat(s: Session, raw: unknown): Promise<void> {
    const parsed = hbBody.safeParse(raw);
    if (!parsed.success) return this.wrongShape(s, "heartbeat", parsed.error.issues);
    const h = parsed.data;
    const nowMs = this.now();
    const changed = h.inverter_online !== s.lastHbInverterOnline || h.map_ver !== s.lastHbMapVer;
    if (!changed && nowMs - s.lastHbWrite < HEARTBEAT_WRITE_EVERY_MS) return;
    s.lastHbWrite = nowMs;
    s.lastHbInverterOnline = h.inverter_online;
    s.lastHbMapVer = h.map_ver;
    await this.d.store.reportHeartbeat({
      equipmentId: s.equipmentId,
      receivedAt: nowMs / 1000,
      boot: h.boot,
      uptimeS: h.uptime_s,
      uploadIntervalS: s.profile.uploadIntervalS,
      ...(h.inverter_online !== undefined ? { inverterOnline: h.inverter_online } : {}),
      ...(h.last_modbus_ok_age_s !== undefined ? { lastModbusOkAgeS: h.last_modbus_ok_age_s } : {}),
      ...(h.fw_version ? { fwVersion: h.fw_version } : {}),
      ...(h.map_ver !== undefined ? { mapVer: h.map_ver } : {}),
      ...(h.rssi !== undefined ? { rssi: h.rssi } : {}),
      ...(h.queue_frames !== undefined ? { queueFrames: h.queue_frames } : {}),
      ...(h.reset_reason ? { resetReason: h.reset_reason } : {}),
      ...(h.clock_valid && h.device_time_ms !== undefined ? { clockOffsetS: h.device_time_ms / 1000 - nowMs / 1000 } : {}),
    });
    if (h.map_ver !== undefined && h.map_ver !== s.mapVersion) await this.publishMap(s, false);
  }

  private async onEvent(s: Session, raw: unknown): Promise<void> {
    const parsed = evtBody.safeParse(raw);
    if (!parsed.success) return this.wrongShape(s, "event", parsed.error.issues);
    const e = parsed.data;
    this.d.log.info({ equipmentId: s.equipmentId, type: e.type, fw: e.fw_version, mapVer: e.map_ver }, "board event");
    if ((e.type === "hello" || e.type === "boot") && e.map_ver !== s.mapVersion) await this.publishMap(s, false);
  }

  // ---- downlink

  private async sealDown(s: Session, name: "ack" | "map", body: unknown): Promise<Buffer | null> {
    const keys = await this.d.keys.get(s.equipmentId);
    const k = keys.find((x) => x.keyId === s.lastKeyRef) ?? keys[0];
    if (!k) return null;
    const counter = Math.min(0xffffffff, Math.max(s.downCounter + 1, Math.floor((this.now() / 1000 - EPOCH_2026) * 8)));
    s.downCounter = counter;
    return seal(body, { equipmentKey: k.key, equipmentId: s.equipmentId, direction: "dn", topic: dnTopic(s.equipmentId, name), counter });
  }

  private async publishMap(s: Session, force: boolean): Promise<void> {
    if (!force && this.now() - s.lastMapPublish < 60_000) return;
    const msg = await this.sealDown(s, "map", mapBody(s.map, s.mapVersion));
    if (!msg) return;
    s.lastMapPublish = this.now();
    await this.d.publish(s.equipmentId, dnTopic(s.equipmentId, "map"), msg, true);
  }

  private async publishAcks(s: Session): Promise<void> {
    const cutoffMs = (s.flushedBoundary - ACK_LAG_S) * 1000;
    for (const [boot, list] of s.pending) {
      let upTo = -1;
      let n = 0;
      for (const p of list) {
        if (p.t >= cutoffMs) break;
        upTo = p.seq;
        n++;
      }
      if (upTo < 0 || upTo <= (s.lastAck.get(boot) ?? -1)) continue;
      const msg = await this.sealDown(s, "ack", { boot, seq: upTo });
      if (!msg) continue;
      await this.d.publish(s.equipmentId, dnTopic(s.equipmentId, "ack"), msg, false);
      s.lastAck.set(boot, upTo);
      list.splice(0, n);
      if (list.length === 0 && boot !== s.lastBoot) s.pending.delete(boot); // a finished earlier boot
    }
  }

  // ---- writing to storage

  /** Writes what is due. Called by the timer; tests call it directly. */
  async tick(nowMs: number): Promise<void> {
    for (const s of this.sessions.values()) {
      if (nowMs >= s.nextFlushAt) await this.flush(s, nowMs);
    }
  }

  async flush(s: Session | string, nowMs: number): Promise<void> {
    const session = typeof s === "string" ? this.sessions.get(s) : s;
    if (!session) return;
    const nowS = nowMs / 1000;
    const closed = session.engine.collectClosed(nowS);
    const latest = [...session.latest].map(([key, v]) => ({ key, value: v.value, ts: v.ts }));
    try {
      const open = session.engine.openAll(nowS);
      if (closed.length > 0 || latest.length > 0 || open.length > 0) await this.d.store.writeSummaries({ equipmentId: session.equipmentId, buckets: closed, open, latest });
    } catch (error) {
      session.engine.requeue(closed);
      session.stats.flushFailures++;
      session.nextFlushAt = nowMs + RETRY_AFTER_FAILED_WRITE_MS;
      this.d.log.warn({ equipmentId: session.equipmentId, err: error instanceof Error ? error.message : String(error) }, "writing summaries failed, will retry");
      return;
    }
    session.latest.clear();
    session.stats.flushes++;
    session.flushedBoundary = bucketStartOf(nowS);
    session.nextFlushAt = this.nextFlush(session.profile.uploadIntervalS, nowS);
    await this.publishAcks(session);
  }

  // ---- diagnostics

  stats(equipmentId: string): Session["stats"] | undefined {
    return this.sessions.get(equipmentId)?.stats;
  }

  mapVersion(equipmentId: string): number | undefined {
    return this.sessions.get(equipmentId)?.mapVersion;
  }
}

/** What the board is sent: the requests, and the registers it may write with their limits. */
export function mapBody(map: RegisterMap, version: number): unknown {
  return {
    ver: version,
    hash: map.hash.slice(0, 16),
    requests: map.requests.map((r) => ({ s: r.start, n: r.count, c: r.cadence })),
    writes: map.writes.map((w) => ({ k: w.key, r: w.register, m: w.mask, lo: w.minRaw, hi: w.maxRaw })),
  };
}

