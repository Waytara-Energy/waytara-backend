/**
 * Hands a freshly made equipment key to a board, readable only by that board (plan section 8.4, step 5).
 *
 * During Bluetooth setup the board makes a P-256 key pair and the phone passes its PUBLIC key to the backend together with the claim
 * ticket. The backend answers with the equipment key encrypted to that public key, so the key is never in the clear in the
 * response, in a proxy log, or on the phone.
 *
 *   shared secret = ECDH(P-256, ephemeral private key, board public key)           (X coordinate, 32 bytes)
 *   AES key       = HKDF-SHA-256(shared secret, salt = ephemeral public key || board public key, info = "waytara/v1/claim")
 *   cipher        = AES-256-GCM, random 12-byte nonce, AAD = context ("<equipmentId>|<hardwareId>")
 *   public keys   are the 65-byte uncompressed points (04 || X || Y)
 *
 * The firmware implements the receiving half (mbedTLS ECDH + HKDF + GCM) and checks itself against test-vectors/claim.json.
 */
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

export const CLAIM_ALG = "ecies-p256-hkdf-sha256-aes256gcm-v1";

export class EciesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EciesError";
  }
}

export interface EciesBox {
  ephemeralPublicKey: Buffer;
  nonce: Buffer;
  /** ciphertext followed by the 16-byte tag */
  ciphertext: Buffer;
}

function aesKey(secret: Buffer, ephemeralPub: Buffer, recipientPub: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, Buffer.concat([ephemeralPub, recipientPub]), Buffer.from("waytara/v1/claim"), 32));
}

export function isValidPublicKey(pub: Uint8Array): boolean {
  if (pub.length !== 65 || pub[0] !== 0x04) return false;
  try {
    // computeSecret rejects a point that is not on the curve
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(Buffer.from(pub));
    return true;
  } catch {
    return false;
  }
}

export function eciesEncrypt(
  recipientPublicKey: Uint8Array,
  plaintext: Uint8Array,
  context: string,
  testing?: { ephemeralPrivateKey?: Uint8Array; nonce?: Uint8Array },
): EciesBox {
  if (!isValidPublicKey(recipientPublicKey)) throw new EciesError("the board public key is not a valid P-256 point");
  const eph = createECDH("prime256v1");
  if (testing?.ephemeralPrivateKey) eph.setPrivateKey(Buffer.from(testing.ephemeralPrivateKey));
  else eph.generateKeys();
  const ephPub = eph.getPublicKey();
  const recipient = Buffer.from(recipientPublicKey);
  const key = aesKey(eph.computeSecret(recipient), ephPub, recipient);
  const nonce = Buffer.from(testing?.nonce ?? randomBytes(12));
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ephemeralPublicKey: ephPub, nonce, ciphertext: ct };
}

/** The board's half, here for tests and for the shared vectors. */
export function eciesDecrypt(recipientPrivateKey: Uint8Array, box: EciesBox, context: string): Buffer {
  const me = createECDH("prime256v1");
  me.setPrivateKey(Buffer.from(recipientPrivateKey));
  const myPub = me.getPublicKey();
  const key = aesKey(me.computeSecret(box.ephemeralPublicKey), box.ephemeralPublicKey, myPub);
  const decipher = createDecipheriv("aes-256-gcm", key, box.nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(box.ciphertext.subarray(box.ciphertext.length - 16));
  try {
    return Buffer.concat([decipher.update(box.ciphertext.subarray(0, box.ciphertext.length - 16)), decipher.final()]);
  } catch {
    throw new EciesError("the box could not be opened");
  }
}
