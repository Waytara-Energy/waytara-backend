import { randomBytes } from "node:crypto";
import type { KeyKind } from "../../db/gateway-db.js";

/**
 * Makes a new equipment secret.
 *
 *   gateway  32 random bytes (the sealing key of the board). Shown to people as base64url, 43 characters.
 *   charger  24 random lowercase letters and digits (about 124 bits): the secret that goes into the charger's address.
 *
 * `plaintext` is what the vault stores (encrypted); `display` is the one-time text the person receives.
 */
export interface NewSecret {
  plaintext: Buffer;
  display: string;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform letters and digits without modulo bias: bytes above the largest multiple of 36 below 256 are thrown away. */
export function randomToken(length: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateSecret(kind: KeyKind): NewSecret {
  if (kind === "gateway") {
    const plaintext = randomBytes(32);
    return { plaintext, display: plaintext.toString("base64url") };
  }
  const display = randomToken(24);
  return { plaintext: Buffer.from(display, "utf8"), display };
}
