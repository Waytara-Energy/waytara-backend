import { timingSafeEqual } from "node:crypto";
import type { KeyVault } from "../../core/key-vault.js";
import type { KeyChangeBus } from "../../lib/key-events.js";
import type { EvStore } from "./store.js";

/**
 * Recognises a charger by the secret in its address (plan 13.2). Every active charger secret is decrypted once and kept for a short time;
 * a key created, rotated or revoked changes the list at once (the key service tells the bus). A secret only counts for the charger name
 * it was made for, so guessing either one alone is useless. Nothing here is ever logged.
 */

export interface ChargerIdentity {
  equipmentId: string;
  keyId: string;
}

interface Entry extends ChargerIdentity {
  secret: Buffer;
  label: string | null;
}

const TTL_MS = 30_000;

export class ChargerRegistry {
  private entries: Entry[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly store: Pick<EvStore, "chargerKeys">,
    private readonly vault: KeyVault,
    bus?: KeyChangeBus,
    private readonly now: () => number = Date.now,
  ) {
    bus?.onChanged(() => this.invalidate());
  }

  invalidate(): void {
    this.loadedAt = 0;
  }

  private async load(): Promise<void> {
    const rows = await this.store.chargerKeys();
    const next: Entry[] = [];
    for (const r of rows) {
      try {
        if (r.expiresAt && Date.parse(r.expiresAt) <= this.now()) continue;
        next.push({ equipmentId: r.equipmentId, keyId: r.keyId, label: r.label, secret: this.vault.decrypt(r.ciphertext, { equipmentId: r.equipmentId, kind: "charger" }) });
      } catch {
        /* a key that cannot be opened is skipped, not fatal */
      }
    }
    this.entries = next;
    this.loadedAt = this.now();
  }

  private async fresh(): Promise<void> {
    if (this.now() - this.loadedAt < TTL_MS) return;
    this.loading ??= this.load().finally(() => (this.loading = null));
    await this.loading;
  }

  /** Is this key still one of the active charger keys? (False once it was revoked or replaced.) */
  async isActive(keyId: string): Promise<boolean> {
    this.invalidate();
    await this.fresh();
    return this.entries.some((e) => e.keyId === keyId);
  }

  /** The charger this secret and name belong to, or null. Compares in constant time and never says which of the two was wrong. */
  async match(secret: string, chargePointId: string): Promise<ChargerIdentity | null> {
    await this.fresh();
    const given = Buffer.from(secret, "utf8");
    let found: Entry | null = null;
    for (const e of this.entries) {
      const same = e.secret.length === given.length && timingSafeEqual(e.secret, given);
      if (same && (e.label === null || e.label === "" || e.label === chargePointId)) found = e; // no early exit: the time does not reveal which entry matched
    }
    return found ? { equipmentId: found.equipmentId, keyId: found.keyId } : null;
  }
}
