/**
 * The sealed envelope every message between a board and the backend travels in (plan section 10.2).
 *
 *   byte 0        version (1)
 *   bytes 1-2     key id: the first two bytes of SHA-256(equipment key), a hint for which key to try while a rotation is in progress
 *   bytes 3-6     counter, big endian, never repeats for one equipment and direction
 *   bytes 7-18    random nonce (12 bytes)
 *   bytes 19-..   ciphertext (AES-256-GCM of a MessagePack body)
 *   last 16       authentication tag
 *
 * The AES key is derived (HKDF-SHA-256) from the equipment key separately for each equipment and direction, so a message
 * captured going up can never be replayed going down. The header and the MQTT topic are authenticated too (AAD): changing the
 * counter or sending the message on another topic makes it fail.
 *
 * The firmware implements the same format. test-vectors/seal.json is the shared proof that both sides agree.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { decode as unpack, encode as pack } from "@msgpack/msgpack";

export const SEAL_VERSION = 1;
export const HEADER_BYTES = 19;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;

export type Direction = "up" | "dn";

export class SealError extends Error {
  readonly reason: "too_short" | "bad_version" | "bad_key" | "authentication_failed" | "bad_body" | "replay";
  constructor(reason: SealError["reason"], message: string) {
    super(message);
    this.name = "SealError";
    this.reason = reason;
  }
}

/** The two bytes in the header that say which key sealed the message. */
export function keyIdOf(equipmentKey: Uint8Array): number {
  const h = createHash("sha256").update(equipmentKey).digest();
  return (h[0]! << 8) | h[1]!;
}

function assertKey(equipmentKey: Uint8Array): void {
  if (equipmentKey.length !== KEY_BYTES) throw new SealError("bad_key", `the equipment key must be ${KEY_BYTES} bytes`);
}

/** HKDF-SHA-256: one AES key per equipment and direction. */
export function deriveKey(equipmentKey: Uint8Array, equipmentId: string, direction: Direction): Buffer {
  assertKey(equipmentKey);
  return Buffer.from(hkdfSync("sha256", equipmentKey, Buffer.from("waytara/v1/seal"), Buffer.from(`${equipmentId}/${direction}`), KEY_BYTES));
}

export interface SealParams {
  equipmentKey: Uint8Array;
  equipmentId: string;
  direction: Direction;
  /** the MQTT topic the message is published on: authenticated, so it cannot be moved to another topic */
  topic: string;
  counter: number;
  /** only for tests and the shared vectors; real messages always use a fresh random nonce */
  nonce?: Uint8Array;
}

function header(keyId: number, counter: number): Buffer {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) throw new SealError("bad_body", "the counter must be a 32-bit unsigned integer");
  const h = Buffer.alloc(HEADER_BYTES - NONCE_BYTES);
  h[0] = SEAL_VERSION;
  h.writeUInt16BE(keyId, 1);
  h.writeUInt32BE(counter, 3);
  return h;
}

function aad(h: Buffer, topic: string): Buffer {
  return Buffer.concat([h, Buffer.from(topic, "utf8")]);
}

/** Seals an already-encoded body. */
export function sealBytes(body: Uint8Array, p: SealParams): Buffer {
  const nonce = Buffer.from(p.nonce ?? randomBytes(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) throw new SealError("bad_body", `the nonce must be ${NONCE_BYTES} bytes`);
  const h = header(keyIdOf(p.equipmentKey), p.counter);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(p.equipmentKey, p.equipmentId, p.direction), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(h, p.topic));
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([h, nonce, ct, cipher.getAuthTag()]);
}

/** Packs a value as MessagePack and seals it. */
export function seal(value: unknown, p: SealParams): Buffer {
  return sealBytes(pack(value), p);
}

export interface Opened<T> {
  keyId: number;
  counter: number;
  body: T;
}

export interface OpenParams {
  equipmentKey: Uint8Array;
  equipmentId: string;
  direction: Direction;
  topic: string;
}

/** Peeks at the header without opening the message: which key id and counter it claims. Nothing here is trusted yet. */
export function peekHeader(message: Uint8Array): { keyId: number; counter: number } {
  if (message.length < HEADER_BYTES + TAG_BYTES) throw new SealError("too_short", "the message is too short to be sealed");
  const b = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  if (b[0] !== SEAL_VERSION) throw new SealError("bad_version", `unknown version ${b[0]}`);
  return { keyId: b.readUInt16BE(1), counter: b.readUInt32BE(3) };
}

export function openBytes(message: Uint8Array, p: OpenParams): { keyId: number; counter: number; body: Buffer } {
  const { keyId, counter } = peekHeader(message);
  const b = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  const h = b.subarray(0, HEADER_BYTES - NONCE_BYTES);
  const nonce = b.subarray(HEADER_BYTES - NONCE_BYTES, HEADER_BYTES);
  const tag = b.subarray(b.length - TAG_BYTES);
  const ct = b.subarray(HEADER_BYTES, b.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(p.equipmentKey, p.equipmentId, p.direction), nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(Buffer.from(h), p.topic));
  decipher.setAuthTag(tag);
  try {
    return { keyId, counter, body: Buffer.concat([decipher.update(ct), decipher.final()]) };
  } catch {
    // Deliberately one message for every cause (wrong key, wrong topic, changed counter, damaged bytes).
    throw new SealError("authentication_failed", "the message did not authenticate");
  }
}

/** Opens a sealed message and unpacks its MessagePack body. */
export function open<T = unknown>(message: Uint8Array, p: OpenParams): Opened<T> {
  const { keyId, counter, body } = openBytes(message, p);
  try {
    return { keyId, counter, body: unpack(body) as T };
  } catch {
    throw new SealError("bad_body", "the sealed body is not valid MessagePack");
  }
}

/**
 * Tries each active key (there are two during a rotation grace period), starting with the one whose id matches the header.
 * Returns which key opened it, so the caller can record that key as used.
 */
export function openWithAnyKey<T = unknown>(
  message: Uint8Array,
  keys: ReadonlyArray<{ id: string; key: Uint8Array }>,
  p: Omit<OpenParams, "equipmentKey">,
): Opened<T> & { keyRef: string } {
  const { keyId } = peekHeader(message);
  const ordered = [...keys].sort((a, b) => Number(keyIdOf(b.key) === keyId) - Number(keyIdOf(a.key) === keyId));
  let last: unknown;
  for (const k of ordered) {
    try {
      return { ...open<T>(message, { ...p, equipmentKey: k.key }), keyRef: k.id };
    } catch (error) {
      last = error;
      if (!(error instanceof SealError) || error.reason !== "authentication_failed") throw error;
    }
  }
  throw last instanceof Error ? last : new SealError("authentication_failed", "the message did not authenticate");
}

/**
 * Replay protection: remembers the highest counter seen and a 64-wide window below it. A counter already seen, or too old,
 * is refused; a slightly late (reordered) message inside the window is accepted once.
 * One guard per equipment and direction. The state is small enough to keep in memory and to persist every few seconds.
 */
export class ReplayGuard {
  private highest = -1;
  private seen = 0n; // bit i set means counter (highest - i) was seen

  constructor(private readonly width = 64) {}

  /** Accepts the counter once; throws SealError('replay') otherwise. Call only AFTER the message authenticated. */
  accept(counter: number): void {
    if (counter > this.highest) {
      const shift = this.highest < 0 ? 0 : counter - this.highest;
      this.seen = shift >= this.width ? 1n : ((this.seen << BigInt(shift)) | 1n) & ((1n << BigInt(this.width)) - 1n);
      this.highest = counter;
      return;
    }
    const back = this.highest - counter;
    if (back >= this.width) throw new SealError("replay", "the counter is too old");
    const bit = 1n << BigInt(back);
    if (this.seen & bit) throw new SealError("replay", "the counter was already used");
    this.seen |= bit;
  }

  get highestCounter(): number {
    return this.highest;
  }

  /** For persisting between restarts. */
  snapshot(): { highest: number; seen: string } {
    return { highest: this.highest, seen: this.seen.toString(16) };
  }

  static restore(state: { highest: number; seen: string }, width = 64): ReplayGuard {
    const g = new ReplayGuard(width);
    g.highest = state.highest;
    g.seen = BigInt(`0x${state.seen}`);
    return g;
  }
}
