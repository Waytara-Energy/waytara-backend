/**
 * The Bluetooth grant (task T15): a short-lived pass the backend signs for one person and one unit, which the unit checks by itself (no
 * network needed) with the equipment key it already holds.
 *
 *   payload (46 bytes)   version(1)=1  level(1)  expires(4, unix seconds, big endian)  pubHash(8)  equipmentId(16)  userId(16)
 *   grant (62 bytes)     payload  mac(16)
 *   mac                  first 16 bytes of HMAC-SHA-256( grantKey, payload )
 *   grantKey             HMAC-SHA-256( equipment key, "wt-ble-grant-key/v1" )
 *   pubHash              first 8 bytes of SHA-256 of the unit's 65-byte Bluetooth public key for this connection
 *
 * Binding to the unit's public key for the connection means a grant cannot be replayed on another connection: the unit makes a new key
 * pair for each phone. Levels: 1 view, 2 network (view and the Wi-Fi), 3 service (and checks, push interval, restart, hub address), 4 admin.
 * The firmware computes the same values (mbedTLS); test-vectors/ble-grant.json is the shared proof.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GRANT_VERSION = 1;
export const GRANT_BYTES = 62;
export const GRANT_LIFETIME_S = 120;
export const LEVELS = { view: 1, network: 2, service: 3, admin: 4 } as const;
export type LevelName = keyof typeof LEVELS;

const uuidBytes = (id: string): Buffer => {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("not a uuid");
  return Buffer.from(hex, "hex");
};

export function deriveGrantKey(equipmentKey: Uint8Array): Buffer {
  if (equipmentKey.length !== 32) throw new Error("the equipment key must be 32 bytes");
  return createHmac("sha256", equipmentKey).update("wt-ble-grant-key/v1", "utf8").digest();
}

export function publicKeyHash(publicKey: Uint8Array): Buffer {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error("the Bluetooth public key must be 65 bytes (04 || X || Y)");
  return createHash("sha256").update(publicKey).digest().subarray(0, 8);
}

export function makeGrant(a: { equipmentKey: Uint8Array; equipmentId: string; userId: string; level: LevelName; expiresAtS: number; devicePublicKey: Uint8Array }): Buffer {
  const p = Buffer.alloc(46);
  p[0] = GRANT_VERSION;
  p[1] = LEVELS[a.level];
  p.writeUInt32BE(a.expiresAtS >>> 0, 2);
  publicKeyHash(a.devicePublicKey).copy(p, 6);
  uuidBytes(a.equipmentId).copy(p, 14);
  uuidBytes(a.userId).copy(p, 30);
  const mac = createHmac("sha256", deriveGrantKey(a.equipmentKey)).update(p).digest().subarray(0, 16);
  return Buffer.concat([p, mac]);
}

export interface OpenedGrant {
  level: number;
  expiresAtS: number;
  equipmentId: string;
  userId: string;
}

/** What the unit does, for the tests: null if the grant is not valid for this key, unit, connection and moment. */
export function openGrant(grant: Uint8Array, a: { equipmentKey: Uint8Array; equipmentId: string; devicePublicKey: Uint8Array; nowS: number }): OpenedGrant | null {
  if (grant.length !== GRANT_BYTES || grant[0] !== GRANT_VERSION) return null;
  const p = Buffer.from(grant.subarray(0, 46));
  const mac = createHmac("sha256", deriveGrantKey(a.equipmentKey)).update(p).digest().subarray(0, 16);
  const given = Buffer.from(grant.subarray(46));
  if (!timingSafeEqual(mac, given)) return null;
  if (!p.subarray(14, 30).equals(uuidBytes(a.equipmentId))) return null;
  if (!p.subarray(6, 14).equals(publicKeyHash(a.devicePublicKey))) return null;
  const expiresAtS = p.readUInt32BE(2);
  if (expiresAtS <= a.nowS || expiresAtS > a.nowS + 600) return null;
  const hex = p.subarray(30, 46).toString("hex");
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { level: p[1]!, expiresAtS, equipmentId: a.equipmentId, userId };
}
