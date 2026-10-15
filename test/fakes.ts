import { randomUUID } from "node:crypto";
import { DbError, type ActiveKey, type EquipmentInfo, type GatewayDb, type KeyEvent, type KeyInfo, type KeyKind } from "../src/db/gateway-db.js";

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
