/**
 * The MQTT login of a board.
 *
 * A board logs in with user name = its equipment id and password = a LOGIN TOKEN derived from its equipment key, not the key itself:
 *
 *   token = base64url( HMAC-SHA-256( key = equipment key, message = "wt-mqtt-login/v1|<equipmentId>" ) )     (43 characters)
 *
 * The derivation is one way. Someone who captures a login token (it crosses TLS, but still) can connect as that board until the key
 * is rotated, yet cannot read or forge a single sealed message, because sealing uses a different derivation of the same key.
 *
 * The firmware computes the same value (mbedTLS HMAC); test-vectors/mqtt-login.json is the shared proof.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function deriveLoginToken(equipmentKey: Uint8Array, equipmentId: string): string {
  if (equipmentKey.length !== 32) throw new Error("the equipment key must be 32 bytes");
  return createHmac("sha256", equipmentKey).update(`wt-mqtt-login/v1|${equipmentId}`, "utf8").digest("base64url");
}

/** Constant-time comparison of a presented token with the expected one. */
export function loginTokenMatches(expected: string, presented: Uint8Array | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
