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
  /** Unlinks the monitoring unit from this equipment and revokes its key, so the unit can be set up for another equipment. False if no unit was linked. */
  releaseBoard(a: { equipmentId: string; actor: string; ip?: string | null }): Promise<boolean>;
  /** How often this unit's summaries and latest values are written to the database (seconds), or null when the person may not manage the unit. */
  getPushInterval(a: { actor: string; equipmentId: string }): Promise<number | null>;
  /** Changes it (60, 120, 300, 600, 900, 1800 or 3600 seconds) and records who did it; returns the previous value. */
  setPushInterval(a: { equipmentId: string; actor: string; seconds: number; ip?: string | null }): Promise<{ previous: number; seconds: number }>;
  /** Replaces a unit's key without cutting it off: makes the new key (both are valid side by side) and starts a rotation. Throws "conflict" if one is already open. */
  beginRotation(a: { oldKeyId: string; ciphertext: Buffer; fingerprint: string; actor: string; ip?: string | null; windowSeconds?: number }): Promise<{ rotationId: string; newKeyId: string; equipmentId: string; expiresAt: string }>;
  /** The unit has the new key aside. False if the rotation is not open any more. */
  rotationStaged(rotationId: string): Promise<boolean>;
  /** The unit logged in with the new key: the old one is cut. False if the rotation is not open. */
  completeRotation(rotationId: string, ip?: string | null): Promise<boolean>;
  /** The new key is cut, the old one stays. False if the rotation is not open. */
  cancelRotation(rotationId: string, reason: string): Promise<boolean>;
  /** The open rotation that this key is the new key of, if any (a login with it means the unit has switched). */
  rotationForLogin(keyId: string): Promise<string | null>;
  /** The unit's open rotation, for the status answer. */
  openRotation(equipmentId: string): Promise<{ rotationId: string; state: "sent" | "staged"; startedAt: string; expiresAt: string } | null>;
  claimDevice(a: { ticket: string; hardwareId: string; ciphertext: Buffer; fingerprint: string; ip?: string | null }): Promise<{ equipmentId: string; keyId: string; issuedTo: string | null }>;
}
