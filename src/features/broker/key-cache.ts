import type { KeyVault } from "../../core/key-vault.js";
import { deriveLoginToken } from "../../core/mqtt-login.js";
import type { GatewayDb } from "../../db/gateway-db.js";

export interface BoardKey {
  keyId: string;
  /** the 32-byte equipment key (sealing) */
  key: Buffer;
  /** what the board presents as its MQTT password */
  loginToken: string;
  expiresAt: number | null;
}

/**
 * The live gateway keys of each equipment, decrypted and kept in memory for a short time so a login does not cost a database call.
 * The cache never writes anywhere. A key change (see KeyChangeBus) clears the entry at once; otherwise it expires on its own.
 */
export class KeyCache {
  private readonly entries = new Map<string, { at: number; keys: BoardKey[] }>();
  private readonly loading = new Map<string, Promise<BoardKey[]>>();

  constructor(
    private readonly db: GatewayDb,
    private readonly vault: KeyVault,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(equipmentId: string): Promise<BoardKey[]> {
    const hit = this.entries.get(equipmentId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.keys.filter((k) => !k.expiresAt || k.expiresAt > this.now());
    const pending = this.loading.get(equipmentId);
    if (pending) return pending;
    const p = this.load(equipmentId).finally(() => this.loading.delete(equipmentId));
    this.loading.set(equipmentId, p);
    return p;
  }

  private async load(equipmentId: string): Promise<BoardKey[]> {
    const rows = await this.db.activeKeys(equipmentId);
    const keys: BoardKey[] = [];
    for (const r of rows) {
      if (r.kind !== "gateway") continue;
      const key = this.vault.decrypt(r.ciphertext, { equipmentId, kind: "gateway" });
      keys.push({ keyId: r.keyId, key, loginToken: deriveLoginToken(key, equipmentId), expiresAt: r.expiresAt ? Date.parse(r.expiresAt) : null });
    }
    this.entries.set(equipmentId, { at: this.now(), keys });
    return keys;
  }

  invalidate(equipmentId: string): void {
    this.entries.delete(equipmentId);
  }
}
