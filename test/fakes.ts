import { randomUUID } from "node:crypto";
import { DbError, type ActiveKey, type CadenceList, type CadenceMetric, type EquipmentInfo, type GatewayDb, type KeyEvent, type KeyInfo, type KeyKind } from "../src/db/gateway-db.js";

/** An in-memory stand-in for the database that behaves like the gw_* functions (see the SQL tests for the real rules). */
export interface FakeKey {
  keyId: string;
  equipmentId: string;
  kind: KeyKind;
  label: string | null;
  ciphertext: Buffer;
  fingerprint: string;
  createdBy: string;
  revokedAt: string | null;
  revokeReason: string | null;
  expiresAt: string | null;
}

export class FakeDb implements GatewayDb {
  equipment = new Map<string, EquipmentInfo>();
  /** `${actor}|${siteId}` */
  access = new Set<string>();
  /** `${actor}|${equipmentId}` */
  manage = new Set<string>();
  /** `${actor}|${equipmentId}` -> what that person may read of the cadence data */
  cadence = new Map<string, "staff" | "customer">();
  keys: FakeKey[] = [];
  tickets = new Map<string, { equipmentId: string; issuedTo: string; hardwareId: string; expires: number; used: boolean }>();
  devices = new Map<string, string>();
  events: { equipmentId: string; keyId?: string | null; event: KeyEvent; actor?: string | null; detail?: Record<string, unknown> }[] = [];
  down: DbError | null = null;
  now = () => Date.now();

  private check(): void {
    if (this.down) throw this.down;
  }

  addEquipment(info: Partial<EquipmentInfo> & { equipmentId: string; siteId: string }): EquipmentInfo {
    const e: EquipmentInfo = { label: null, category: "solar_inverter", technicalSpecs: { mppt_count: 2 }, ...info };
    this.equipment.set(e.equipmentId, e);
    return e;
  }

  async ping(): Promise<void> {
    this.check();
  }

  async actorCanAccessSite(actor: string, site: string): Promise<boolean> {
    this.check();
    return this.access.has(`${actor}|${site}`);
  }

  async actorCanManageKeys(actor: string, equipment: string): Promise<boolean> {
    this.check();
    return this.manage.has(`${actor}|${equipment}`);
  }

  async cadenceAccess(actor: string, equipment: string): Promise<"staff" | "customer" | null> {
    this.check();
    return this.cadence.get(`${actor}|${equipment}`) ?? null;
  }

  async equipmentInfo(equipment: string): Promise<EquipmentInfo | null> {
    this.check();
    return this.equipment.get(equipment) ?? null;
  }

  async keyInfo(key: string): Promise<KeyInfo | null> {
    this.check();
    const k = this.keys.find((x) => x.keyId === key);
    return k ? { keyId: k.keyId, equipmentId: k.equipmentId, kind: k.kind, label: k.label, revokedAt: k.revokedAt, expiresAt: k.expiresAt } : null;
  }

  async createKey(a: Parameters<GatewayDb["createKey"]>[0]): Promise<string> {
    this.check();
    if (a.ciphertext.length < 28) throw new DbError("invalid", "short");
    const keyId = randomUUID();
    this.keys.push({ keyId, equipmentId: a.equipmentId, kind: a.kind, label: a.label ?? null, ciphertext: a.ciphertext, fingerprint: a.fingerprint, createdBy: a.actor, revokedAt: null, revokeReason: null, expiresAt: a.expiresAt ?? null });
    this.events.push({ equipmentId: a.equipmentId, keyId, event: "created", actor: a.actor });
    return keyId;
  }

  async rotateKey(a: Parameters<GatewayDb["rotateKey"]>[0]): Promise<string> {
    this.check();
    const old = this.keys.find((k) => k.keyId === a.keyId && !k.revokedAt);
    if (!old) throw new DbError("not_found", "none");
    const keyId = randomUUID();
    this.keys.push({ keyId, equipmentId: old.equipmentId, kind: old.kind, label: old.label, ciphertext: a.ciphertext, fingerprint: a.fingerprint, createdBy: a.actor, revokedAt: null, revokeReason: null, expiresAt: null });
    if (a.graceSeconds === 0) {
      old.revokedAt = new Date(this.now()).toISOString();
      old.revokeReason = "rotated";
    } else {
      old.expiresAt = new Date(this.now() + a.graceSeconds * 1000).toISOString();
    }
    this.events.push({ equipmentId: old.equipmentId, keyId, event: "rotated", actor: a.actor, detail: { graceSeconds: a.graceSeconds } });
    return keyId;
  }

  async revokeKey(a: Parameters<GatewayDb["revokeKey"]>[0]): Promise<boolean> {
    this.check();
    const k = this.keys.find((x) => x.keyId === a.keyId && !x.revokedAt);
    if (!k) return false;
    k.revokedAt = new Date(this.now()).toISOString();
    k.revokeReason = a.reason ?? "revoked";
    this.events.push({ equipmentId: k.equipmentId, keyId: k.keyId, event: "revoked", actor: a.actor });
    return true;
  }

  async activeKeys(equipmentId: string): Promise<ActiveKey[]> {
    this.check();
    return this.keys
      .filter((k) => k.equipmentId === equipmentId && !k.revokedAt && (!k.expiresAt || Date.parse(k.expiresAt) > this.now()))
      .map((k) => ({ keyId: k.keyId, kind: k.kind, ciphertext: k.ciphertext, expiresAt: k.expiresAt }));
  }

  touched: { keyId: string; ip: string | null }[] = [];

  async touchKey(keyId: string, ip?: string | null): Promise<void> {
    this.check();
    this.touched.push({ keyId, ip: ip ?? null });
  }

  async recordKeyEvent(a: Parameters<GatewayDb["recordKeyEvent"]>[0]): Promise<void> {
    this.check();
    this.events.push({ equipmentId: a.equipmentId, keyId: a.keyId ?? null, event: a.event, actor: a.actor ?? null, ...(a.detail ? { detail: a.detail } : {}) });
  }

  async issueClaimTicket(a: Parameters<GatewayDb["issueClaimTicket"]>[0]): Promise<{ ticket: string; expiresAt: string }> {
    this.check();
    for (const t of this.tickets.values()) if (t.equipmentId === a.equipmentId) t.used = true;
    const ticket = randomUUID();
    const expires = this.now() + 15 * 60_000;
    this.tickets.set(ticket, { equipmentId: a.equipmentId, issuedTo: a.issuedTo, hardwareId: a.hardwareId, expires, used: false });
    this.events.push({ equipmentId: a.equipmentId, event: "ticket_issued", actor: a.issuedTo });
    return { ticket, expiresAt: new Date(expires).toISOString() };
  }

  private open(ticket: string, hardwareId: string) {
    const t = this.tickets.get(ticket);
    return t && !t.used && t.expires > this.now() && t.hardwareId === hardwareId ? t : null;
  }

  async claimPeek(ticket: string, hardwareId: string): Promise<{ equipmentId: string } | null> {
    this.check();
    const t = this.open(ticket, hardwareId);
    return t ? { equipmentId: t.equipmentId } : null;
  }

  async releaseBoard(a: Parameters<GatewayDb["releaseBoard"]>[0]): Promise<boolean> {
    this.check();
    if (!this.devices.has(a.equipmentId)) return false;
    for (const k of this.keys) {
      if (k.equipmentId === a.equipmentId && k.kind === "gateway" && !k.revokedAt) {
        k.revokedAt = new Date(this.now()).toISOString();
        k.revokeReason = "released";
        this.events.push({ equipmentId: a.equipmentId, keyId: k.keyId, event: "revoked", actor: a.actor, detail: { reason: "released" } });
      }
    }
    this.devices.delete(a.equipmentId);
    return true;
  }

  rotations: { id: string; equipmentId: string; oldKeyId: string; newKeyId: string; state: "sent" | "staged" | "done" | "cancelled"; startedAt: string; expiresAt: string; actor: string; reason?: string }[] = [];

  async beginRotation(a: Parameters<GatewayDb["beginRotation"]>[0]): Promise<{ rotationId: string; newKeyId: string; equipmentId: string; expiresAt: string }> {
    this.check();
    const old = this.keys.find((k) => k.keyId === a.oldKeyId && !k.revokedAt && k.kind === "gateway");
    if (!old) throw new DbError("not_found", "no such active unit key");
    if (this.rotations.some((r) => r.equipmentId === old.equipmentId && (r.state === "sent" || r.state === "staged"))) throw new DbError("conflict", "a rotation is already in progress");
    const newKeyId = randomUUID();
    this.keys.push({ keyId: newKeyId, equipmentId: old.equipmentId, kind: "gateway", label: old.label, ciphertext: a.ciphertext, fingerprint: a.fingerprint, createdBy: a.actor, revokedAt: null, revokeReason: null, expiresAt: null });
    const rotationId = randomUUID();
    const expiresAt = new Date(this.now() + (a.windowSeconds ?? 600) * 1000).toISOString();
    this.rotations.push({ id: rotationId, equipmentId: old.equipmentId, oldKeyId: old.keyId, newKeyId, state: "sent", startedAt: new Date(this.now()).toISOString(), expiresAt, actor: a.actor });
    return { rotationId, newKeyId, equipmentId: old.equipmentId, expiresAt };
  }

  async rotationStaged(rotationId: string): Promise<boolean> {
    this.check();
    const r = this.rotations.find((x) => x.id === rotationId && x.state === "sent");
    if (!r) return false;
    r.state = "staged";
    return true;
  }

  async completeRotation(rotationId: string): Promise<boolean> {
    this.check();
    const r = this.rotations.find((x) => x.id === rotationId && (x.state === "sent" || x.state === "staged"));
    if (!r) return false;
    const old = this.keys.find((k) => k.keyId === r.oldKeyId);
    if (old && !old.revokedAt) {
      old.revokedAt = new Date(this.now()).toISOString();
      old.revokeReason = "rotated";
    }
    r.state = "done";
    this.events.push({ equipmentId: r.equipmentId, keyId: r.newKeyId, event: "rotated", actor: r.actor, detail: { remote: true } });
    return true;
  }

  async cancelRotation(rotationId: string, reason: string): Promise<boolean> {
    this.check();
    const r = this.rotations.find((x) => x.id === rotationId && (x.state === "sent" || x.state === "staged"));
    if (!r) return false;
    const nk = this.keys.find((k) => k.keyId === r.newKeyId);
    if (nk && !nk.revokedAt) {
      nk.revokedAt = new Date(this.now()).toISOString();
      nk.revokeReason = "rotation_cancelled";
    }
    r.state = "cancelled";
    r.reason = reason;
    return true;
  }

  async rotationForLogin(keyId: string): Promise<string | null> {
    this.check();
    return this.rotations.find((x) => x.newKeyId === keyId && (x.state === "sent" || x.state === "staged"))?.id ?? null;
  }

  async openRotation(equipmentId: string): Promise<{ rotationId: string; state: "sent" | "staged"; startedAt: string; expiresAt: string } | null> {
    this.check();
    const r = this.rotations.find((x) => x.equipmentId === equipmentId && (x.state === "sent" || x.state === "staged"));
    return r ? { rotationId: r.id, state: r.state as "sent" | "staged", startedAt: r.startedAt, expiresAt: r.expiresAt } : null;
  }

  /** `${actor}|${equipmentId}` -> the Bluetooth level that person gets */
  ble = new Map<string, "network" | "service" | "admin">();
  bleRequests: { actor: string; equipmentId: string }[] = [];
  async bleAccess(a: { actor: string; equipmentId: string }): Promise<"network" | "service" | "admin" | null> {
    this.check();
    const l = this.ble.get(`${a.actor}|${a.equipmentId}`) ?? null;
    if (l) this.bleRequests.push({ actor: a.actor, equipmentId: a.equipmentId });
    return l;
  }

  intervals = new Map<string, number>();

  async getPushInterval(a: Parameters<GatewayDb["getPushInterval"]>[0]): Promise<number | null> {
    this.check();
    return this.manage.has(`${a.actor}|${a.equipmentId}`) ? (this.intervals.get(a.equipmentId) ?? 900) : null;
  }

  cadences = new Map<string, CadenceMetric[]>();

  async getCadences(a: Parameters<GatewayDb["getCadences"]>[0]): Promise<CadenceList | null> {
    this.check();
    if (!this.manage.has(`${a.actor}|${a.equipmentId}`)) return null;
    return { allowed: [10, 15, 30, 60, 120, 300, 600, 900], default: 30, metrics: this.cadences.get(a.equipmentId) ?? [] };
  }

  async setCadences(a: Parameters<GatewayDb["setCadences"]>[0]): Promise<{ changed: number }> {
    this.check();
    if (!this.manage.has(`${a.actor}|${a.equipmentId}`)) throw new DbError("forbidden", "not allowed");
    const list = this.cadences.get(a.equipmentId) ?? [];
    let changed = 0;
    for (const c of a.changes) {
      if (c.seconds !== null && ![10, 15, 30, 60, 120, 300, 600, 900].includes(c.seconds)) throw new DbError("invalid", "not an allowed rate");
      const m = list.find((x) => x.key === c.key);
      if (!m) throw new DbError("invalid", "unknown value");
      const to = c.seconds ?? m.map_s;
      if (to !== m.seconds) {
        m.seconds = to;
        m.custom = to !== m.map_s;
        changed++;
      }
    }
    return { changed };
  }

  async setPushInterval(a: Parameters<GatewayDb["setPushInterval"]>[0]): Promise<{ previous: number; seconds: number }> {
    this.check();
    if (!this.manage.has(`${a.actor}|${a.equipmentId}`)) throw new DbError("forbidden", "not allowed");
    if (![60, 120, 300, 600, 900, 1800, 3600].includes(a.seconds)) throw new DbError("invalid", "not an allowed interval");
    const previous = this.intervals.get(a.equipmentId) ?? 900;
    this.intervals.set(a.equipmentId, a.seconds);
    return { previous, seconds: a.seconds };
  }

  async claimDevice(a: Parameters<GatewayDb["claimDevice"]>[0]): Promise<{ equipmentId: string; keyId: string; issuedTo: string | null }> {
    this.check();
    const t = this.open(a.ticket, a.hardwareId);
    if (!t) throw new DbError("not_found", "Invalid ticket");
    t.used = true;
    for (const [eq, hw] of this.devices) if (hw === a.hardwareId && eq !== t.equipmentId) throw new DbError("conflict", "taken");
    for (const k of this.keys) if (k.equipmentId === t.equipmentId && k.kind === "gateway" && !k.revokedAt) { k.revokedAt = new Date(this.now()).toISOString(); k.revokeReason = "reclaimed"; }
    const keyId = randomUUID();
    this.keys.push({ keyId, equipmentId: t.equipmentId, kind: "gateway", label: `board ${a.hardwareId}`, ciphertext: a.ciphertext, fingerprint: a.fingerprint, createdBy: t.issuedTo, revokedAt: null, revokeReason: null, expiresAt: null });
    this.devices.set(t.equipmentId, a.hardwareId);
    this.events.push({ equipmentId: t.equipmentId, keyId, event: "claimed", actor: t.issuedTo });
    return { equipmentId: t.equipmentId, keyId, issuedTo: t.issuedTo };
  }
}
