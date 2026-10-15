/**
 * Everything the backend asks of the database, as one interface. The real implementation calls the gw_* functions as the service
 * user (supabase-gateway-db.ts); tests use an in-memory one. The backend has no table access of its own.
 */

export type KeyKind = "gateway" | "charger";

export interface EquipmentInfo {
  equipmentId: string;
  siteId: string;
  label: string | null;
  /** stock category, for example solar_inverter or ev_charger */
  category: string | null;
  technicalSpecs: Record<string, unknown> | null;
}

export interface KeyInfo {
  keyId: string;
  equipmentId: string;
  kind: KeyKind;
  label: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export interface ActiveKey {
  keyId: string;
  kind: KeyKind;
  ciphertext: Buffer;
  expiresAt: string | null;
}

export type KeyEvent = "created" | "rotated" | "revoked" | "expired" | "auth_failed" | "claimed" | "ticket_issued";

/** Why a database call was refused, in terms the callers can act on. */
export class DbError extends Error {
  readonly kind: "forbidden" | "not_found" | "conflict" | "invalid" | "unavailable";
  constructor(kind: DbError["kind"], message: string) {
    super(message);
    this.name = "DbError";
    this.kind = kind;
  }
}

export interface GatewayDb {
  /** Proves the sign-in and the function permission work. Throws if not. */
  ping(): Promise<void>;

  actorCanAccessSite(actor: string, site: string): Promise<boolean>;
  actorCanManageKeys(actor: string, equipment: string): Promise<boolean>;
  /** May this person read the cadence data of this equipment, and as whom: staff see every value, a customer only what customers see. null = no. */
  cadenceAccess(actor: string, equipment: string): Promise<"staff" | "customer" | null>;
  equipmentInfo(equipment: string): Promise<EquipmentInfo | null>;

  keyInfo(key: string): Promise<KeyInfo | null>;
  createKey(a: { equipmentId: string; kind: KeyKind; label?: string | null; ciphertext: Buffer; fingerprint: string; actor: string; ip?: string | null; expiresAt?: string | null }): Promise<string>;
  rotateKey(a: { keyId: string; ciphertext: Buffer; fingerprint: string; actor: string; ip?: string | null; graceSeconds: number }): Promise<string>;
  revokeKey(a: { keyId: string; actor: string; ip?: string | null; reason?: string | null }): Promise<boolean>;
  activeKeys(equipmentId: string): Promise<ActiveKey[]>;
  touchKey(keyId: string, ip?: string | null): Promise<void>;
  recordKeyEvent(a: { equipmentId: string; keyId?: string | null; event: KeyEvent; actor?: string | null; ip?: string | null; detail?: Record<string, unknown> }): Promise<void>;

  issueClaimTicket(a: { equipmentId: string; issuedTo: string; hardwareId: string; ip?: string | null }): Promise<{ ticket: string; expiresAt: string }>;
  claimPeek(ticket: string, hardwareId: string): Promise<{ equipmentId: string } | null>;
  claimDevice(a: { ticket: string; hardwareId: string; ciphertext: Buffer; fingerprint: string; ip?: string | null }): Promise<{ equipmentId: string; keyId: string; issuedTo: string | null }>;
}
