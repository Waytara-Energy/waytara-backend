import { createECDH, createCipheriv, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EciesError, eciesDecrypt, eciesEncrypt, isValidPublicKey } from "../src/core/ecies.js";

const v = JSON.parse(readFileSync(new URL("../test-vectors/claim.json", import.meta.url), "utf8"));
const h = (s: string) => Buffer.from(s, "hex");

describe("shared claim vector (the firmware must open this box)", () => {
  it("reproduces the exact bytes", () => {
    const box = eciesEncrypt(h(v.boardPublicKeyHex), h(v.equipmentKeyHex), v.context, { ephemeralPrivateKey: h(v.ephemeralPrivateKeyHex), nonce: h(v.nonceHex) });
    expect(box.ephemeralPublicKey.toString("hex")).toBe(v.serverPublicKeyHex);
    expect(box.ciphertext.toString("hex")).toBe(v.ciphertextWithTagHex);
  });

  it("opens with the board's private key", () => {
    const key = eciesDecrypt(h(v.boardPrivateKeyHex), { ephemeralPublicKey: h(v.serverPublicKeyHex), nonce: h(v.nonceHex), ciphertext: h(v.ciphertextWithTagHex) }, v.context);
    expect(key.toString("hex")).toBe(v.equipmentKeyHex);
  });

  it("matches a separate step by step implementation of the written format", () => {
    const eph = createECDH("prime256v1");
    eph.setPrivateKey(h(v.ephemeralPrivateKeyHex));
    const secret = eph.computeSecret(h(v.boardPublicKeyHex));
    const key = Buffer.from(hkdfSync("sha256", secret, Buffer.concat([eph.getPublicKey(), h(v.boardPublicKeyHex)]), Buffer.from("waytara/v1/claim"), 32));
    const c = createCipheriv("aes-256-gcm", key, h(v.nonceHex), { authTagLength: 16 });
    c.setAAD(Buffer.from(v.context));
    const out = Buffer.concat([c.update(h(v.equipmentKeyHex)), c.final(), c.getAuthTag()]);
    expect(out.toString("hex")).toBe(v.ciphertextWithTagHex);
  });
});

describe("eciesEncrypt", () => {
  const board = createECDH("prime256v1");
  board.generateKeys();

  it("round-trips with a fresh ephemeral key each time", () => {
    const key = Buffer.alloc(32, 5);
    const a = eciesEncrypt(board.getPublicKey(), key, "ctx");
    const b = eciesEncrypt(board.getPublicKey(), key, "ctx");
    expect(a.ephemeralPublicKey.equals(b.ephemeralPublicKey)).toBe(false);
    expect(eciesDecrypt(board.getPrivateKey(), a, "ctx").equals(key)).toBe(true);
  });

  it("does not contain the key in the clear", () => {
    const key = Buffer.from("THIS-IS-THE-EQUIPMENT-KEY-000000");
    const box = eciesEncrypt(board.getPublicKey(), key, "ctx");
    expect(box.ciphertext.toString("latin1")).not.toContain("EQUIPMENT-KEY");
  });

  it("will not open for another board, another context, or after tampering", () => {
    const key = Buffer.alloc(32, 5);
    const box = eciesEncrypt(board.getPublicKey(), key, "ctx-1");
    const stranger = createECDH("prime256v1");
    stranger.generateKeys();
    expect(() => eciesDecrypt(stranger.getPrivateKey(), box, "ctx-1")).toThrow(EciesError);
    expect(() => eciesDecrypt(board.getPrivateKey(), box, "ctx-2")).toThrow(EciesError);
    for (let i = 0; i < box.ciphertext.length; i++) {
      const bad = Buffer.from(box.ciphertext);
      bad[i] = bad[i]! ^ 1;
      expect(() => eciesDecrypt(board.getPrivateKey(), { ...box, ciphertext: bad }, "ctx-1")).toThrow(EciesError);
    }
  });

  it("refuses a public key that is not a point on the curve", () => {
    const bad = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
    expect(isValidPublicKey(bad)).toBe(false);
    expect(() => eciesEncrypt(bad, Buffer.alloc(32), "ctx")).toThrow(/valid P-256 point/);
    expect(isValidPublicKey(Buffer.alloc(10))).toBe(false);
    expect(isValidPublicKey(Buffer.concat([Buffer.from([2]), board.getPublicKey().subarray(1)]))).toBe(false);
    expect(isValidPublicKey(board.getPublicKey())).toBe(true);
  });
});
