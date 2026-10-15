import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyVault, VaultError, parseMasterKey } from "../src/core/key-vault.js";

const master = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 9);
const ctx = { equipmentId: "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2", kind: "gateway" as const };

describe("KeyVault", () => {
  it("round-trips a key and stores something the database check accepts (28 bytes or more)", () => {
    const vault = new KeyVault({ current: master });
    const key = randomBytes(32);
    const blob = vault.encrypt(key, ctx);
    expect(blob.length).toBe(3 + 12 + 32 + 16);
    expect(blob.length).toBeGreaterThanOrEqual(28);
    expect(vault.decrypt(blob, ctx).equals(key)).toBe(true);
  });

  it("never stores the key in the clear and uses a new nonce each time", () => {
    const vault = new KeyVault({ current: master });
    const key = Buffer.from("a-charger-secret-in-the-clear-24");
    const a = vault.encrypt(key, { ...ctx, kind: "charger" });
    const b = vault.encrypt(key, { ...ctx, kind: "charger" });
    expect(a.equals(b)).toBe(false);
    expect(a.toString("latin1")).not.toContain("charger-secret");
  });

  it("will not open a value moved to another equipment or kind", () => {
    const vault = new KeyVault({ current: master });
    const blob = vault.encrypt(randomBytes(32), ctx);
    expect(() => vault.decrypt(blob, { ...ctx, equipmentId: "11111111-2222-3333-4444-555555555555" })).toThrow(VaultError);
    expect(() => vault.decrypt(blob, { ...ctx, kind: "charger" })).toThrow(VaultError);
  });

  it("detects any changed byte", () => {
    const vault = new KeyVault({ current: master });
    const blob = vault.encrypt(randomBytes(32), ctx);
    for (let i = 0; i < blob.length; i++) {
      const bad = Buffer.from(blob);
      bad[i] = bad[i]! ^ 0x01;
      expect(() => vault.decrypt(bad, ctx), `byte ${i}`).toThrow(VaultError);
    }
  });

  it("refuses a different master key and a truncated value", () => {
    const blob = new KeyVault({ current: master }).encrypt(randomBytes(32), ctx);
    expect(() => new KeyVault({ current: other }).decrypt(blob, ctx)).toThrow(/not configured/);
    expect(() => new KeyVault({ current: master }).decrypt(blob.subarray(0, 20), ctx)).toThrow(/too short/);
  });

  it("opens old keys with the previous master and says which need re-encrypting", () => {
    const old = new KeyVault({ current: other }).encrypt(Buffer.from("old-key-material-0123456789abcd"), ctx);
    const rotated = new KeyVault({ current: master, previous: other });
    expect(rotated.decrypt(old, ctx).toString()).toBe("old-key-material-0123456789abcd");
    expect(rotated.needsReencrypt(old)).toBe(true);
    const fresh = rotated.encrypt(Buffer.from("x".repeat(32)), ctx);
    expect(rotated.needsReencrypt(fresh)).toBe(false);
    expect(new KeyVault({ current: master }).decrypt(fresh, ctx).length).toBe(32);
  });

  it("rejects master keys of the wrong size", () => {
    expect(() => new KeyVault({ current: Buffer.alloc(16) })).toThrow(/32 bytes/);
    expect(() => new KeyVault({ current: master, previous: Buffer.alloc(5) })).toThrow(/32 bytes/);
  });

  it("gives a short fingerprint that identifies a key without revealing it", () => {
    const f = KeyVault.fingerprint(Buffer.alloc(32, 1));
    expect(f).toMatch(/^[0-9a-f]{12}$/);
    expect(KeyVault.fingerprint(Buffer.alloc(32, 2))).not.toBe(f);
  });
});

describe("parseMasterKey", () => {
  it("accepts 32 bytes of base64", () => {
    const text = randomBytes(32).toString("base64");
    expect(text.length).toBe(44);
    expect(parseMasterKey(text).length).toBe(32);
  });

  it("refuses anything else without printing it", () => {
    for (const bad of ["", "short", Buffer.alloc(16).toString("base64"), "not base64 at all !!!!", `${randomBytes(32).toString("base64")}x`]) {
      try {
        parseMasterKey(bad);
        throw new Error("should have failed");
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        if (bad.length > 3) expect((e as Error).message).not.toContain(bad);
      }
    }
  });
});
