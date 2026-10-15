/**
 * Encryption of equipment keys at rest.
 *
 * Every equipment key is stored in the database only as the output of this vault. The master key lives in Render's settings and in
 * the owner's password manager, never in the database or in git.
 *
 *   layout   version(1) masterId(2) nonce(12) ciphertext tag(16)         (at least 31 bytes; the database insists on 28)
 *   cipher   AES-256-GCM with a key derived from the master by HKDF-SHA-256
 *   AAD      "wt-key/v1/<equipmentId>/<kind>": a stored value copied to another row (another equipment, another kind) will not open
 *
 * Two masters can be configured at once (current and previous) so the master can be rotated: new keys use the current one and old
 * ones keep opening with the previous one until they are re-encrypted. masterId (first two bytes of sha256(master)) says which.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export const VAULT_VERSION = 1;
const NONCE = 12;
const TAG = 16;

export type KeyKind = "gateway" | "charger";

export interface VaultContext {
  equipmentId: string;
  kind: KeyKind;
}

export class VaultError extends Error {
  readonly reason: "bad_master" | "too_short" | "bad_version" | "unknown_master" | "cannot_open";
  constructor(reason: VaultError["reason"], message: string) {
    super(message);
    this.name = "VaultError";
    this.reason = reason;
  }
}

function masterId(master: Uint8Array): number {
  const h = createHash("sha256").update(master).digest();
  return (h[0]! << 8) | h[1]!;
}

function derive(master: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("waytara/v1/vault"), Buffer.from("equipment-key"), 32));
}

const aad = (c: VaultContext) => Buffer.from(`wt-key/v1/${c.equipmentId}/${c.kind}`, "utf8");

export class KeyVault {
  private readonly current: { id: number; key: Buffer };
  private readonly previous: { id: number; key: Buffer } | undefined;

  constructor(masters: { current: Uint8Array; previous?: Uint8Array }) {
    if (masters.current.length !== 32) throw new VaultError("bad_master", "the master key must be 32 bytes");
    if (masters.previous && masters.previous.length !== 32) throw new VaultError("bad_master", "the previous master key must be 32 bytes");
    this.current = { id: masterId(masters.current), key: derive(masters.current) };
    this.previous = masters.previous ? { id: masterId(masters.previous), key: derive(masters.previous) } : undefined;
  }

  encrypt(plaintext: Uint8Array, ctx: VaultContext, nonce: Uint8Array = randomBytes(NONCE)): Buffer {
    const header = Buffer.alloc(3);
    header[0] = VAULT_VERSION;
    header.writeUInt16BE(this.current.id, 1);
    const cipher = createCipheriv("aes-256-gcm", this.current.key, nonce, { authTagLength: TAG });
    cipher.setAAD(Buffer.concat([header, aad(ctx)]));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, Buffer.from(nonce), ct, cipher.getAuthTag()]);
  }

  decrypt(blob: Uint8Array, ctx: VaultContext): Buffer {
    if (blob.length < 3 + NONCE + TAG) throw new VaultError("too_short", "the stored key is too short");
    const b = Buffer.from(blob);
    if (b[0] !== VAULT_VERSION) throw new VaultError("bad_version", `unknown vault version ${b[0]}`);
    const id = b.readUInt16BE(1);
    const m = [this.current, this.previous].find((x) => x && x.id === id);
    if (!m) throw new VaultError("unknown_master", "the stored key was encrypted with a master key that is not configured");
    const decipher = createDecipheriv("aes-256-gcm", m.key, b.subarray(3, 3 + NONCE), { authTagLength: TAG });
    decipher.setAAD(Buffer.concat([b.subarray(0, 3), aad(ctx)]));
    decipher.setAuthTag(b.subarray(b.length - TAG));
    try {
      return Buffer.concat([decipher.update(b.subarray(3 + NONCE, b.length - TAG)), decipher.final()]);
    } catch {
      throw new VaultError("cannot_open", "the stored key could not be opened");
    }
  }

  /** True when this blob was written with the previous master and should be re-encrypted with the current one. */
  needsReencrypt(blob: Uint8Array): boolean {
    return blob.length >= 3 && Buffer.from(blob).readUInt16BE(1) !== this.current.id;
  }

  /** A short, non-reversible label that identifies a key without revealing it (shown in lists and logs). */
  static fingerprint(plaintext: Uint8Array): string {
    return createHash("sha256").update(plaintext).digest("hex").slice(0, 12);
  }
}

export function parseMasterKey(base64: string): Buffer {
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== 32 || buf.toString("base64") !== base64.trim()) throw new VaultError("bad_master", "the master key must be 32 random bytes in base64");
  return buf;
}
