import { createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { decode as unpack, encode as pack } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { ReplayGuard, SealError, deriveKey, keyIdOf, open, openBytes, openWithAnyKey, peekHeader, seal, sealBytes } from "../src/core/seal.js";

const file = JSON.parse(readFileSync(new URL("../test-vectors/seal.json", import.meta.url), "utf8"));
const key = Buffer.from(file.equipmentKeyHex, "hex");
const id: string = file.equipmentId;
const params = (dir: "up" | "dn", topic: string, counter: number) => ({ equipmentKey: key, equipmentId: id, direction: dir, topic, counter });

describe("shared test vectors (the firmware must reproduce these bytes)", () => {
  for (const v of file.vectors) {
    it(v.name, () => {
      const plaintext = Buffer.from(v.plaintextMsgpackHex, "hex");
      const nonce = Buffer.from(v.nonceHex, "hex");
      expect(deriveKey(key, id, v.direction).toString("hex")).toBe(v.derivedKeyHex);
      expect(keyIdOf(key).toString(16).padStart(4, "0")).toBe(file.keyIdHex);
      const sealed = sealBytes(plaintext, { ...params(v.direction, v.topic, v.counter), nonce });
      expect(sealed.toString("hex")).toBe(v.sealedHex);
      const opened = openBytes(Buffer.from(v.sealedHex, "hex"), { equipmentKey: key, equipmentId: id, direction: v.direction, topic: v.topic });
      expect(opened.counter).toBe(v.counter);
      expect(opened.body.toString("hex")).toBe(v.plaintextMsgpackHex);
    });
  }

  it("matches a separate, step by step implementation of the written format", () => {
    // Written from the description in the vector file only, with no use of the module under test.
    const v = file.vectors[0];
    const ikm = key;
    const aesKey = Buffer.from(hkdfSync("sha256", ikm, Buffer.from("waytara/v1/seal"), Buffer.from(`${id}/${v.direction}`), 32));
    const header = Buffer.concat([Buffer.from([1]), Buffer.from(file.keyIdHex, "hex"), Buffer.from([0, 0, 0, v.counter])]);
    const c = createCipheriv("aes-256-gcm", aesKey, Buffer.from(v.nonceHex, "hex"), { authTagLength: 16 });
    c.setAAD(Buffer.concat([header, Buffer.from(v.topic, "utf8")]));
    const ct = Buffer.concat([c.update(Buffer.from(v.plaintextMsgpackHex, "hex")), c.final()]);
    const expected = Buffer.concat([header, Buffer.from(v.nonceHex, "hex"), ct, c.getAuthTag()]);
    expect(expected.toString("hex")).toBe(v.sealedHex);
    const d = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(v.nonceHex, "hex"), { authTagLength: 16 });
    d.setAAD(Buffer.concat([header, Buffer.from(v.topic, "utf8")]));
    d.setAuthTag(expected.subarray(expected.length - 16));
    expect(Buffer.concat([d.update(expected.subarray(19, expected.length - 16)), d.final()]).toString("hex")).toBe(v.plaintextMsgpackHex);
  });
});

describe("seal and open", () => {
  const topic = `wt/v1/${id}/up/hb`;

  it("round-trips any MessagePack value", () => {
    const body = { uptime_s: 1234, rssi: -61, inverter_online: true, name: "board", list: [1, 2.5, null] };
    const sealed = seal(body, params("up", topic, 1));
    const opened = open<typeof body>(sealed, { equipmentKey: key, equipmentId: id, direction: "up", topic });
    expect(opened.body).toEqual(body);
    expect(opened.counter).toBe(1);
  });

  it("uses a fresh random nonce each time", () => {
    const a = seal({ x: 1 }, params("up", topic, 1));
    const b = seal({ x: 1 }, params("up", topic, 1));
    expect(a.equals(b)).toBe(false);
  });

  it("adds nothing readable: the plaintext does not appear in the sealed bytes", () => {
    const sealed = seal({ secret: "WIFI-PASSWORD-1234" }, params("up", topic, 2));
    expect(sealed.toString("latin1")).not.toContain("WIFI-PASSWORD-1234");
    expect(sealed.length).toBe(19 + pack({ secret: "WIFI-PASSWORD-1234" }).length + 16);
  });

  it("refuses a message sealed for another topic", () => {
    const sealed = seal({ x: 1 }, params("up", topic, 3));
    expect(() => open(sealed, { equipmentKey: key, equipmentId: id, direction: "up", topic: `wt/v1/${id}/up/data` })).toThrow(SealError);
  });

  it("refuses a message replayed in the other direction", () => {
    const sealed = seal({ x: 1 }, params("up", topic, 3));
    expect(() => open(sealed, { equipmentKey: key, equipmentId: id, direction: "dn", topic })).toThrow(/did not authenticate/);
  });

  it("refuses another equipment's key or id", () => {
    const sealed = seal({ x: 1 }, params("up", topic, 3));
    expect(() => open(sealed, { equipmentKey: Buffer.alloc(32, 9), equipmentId: id, direction: "up", topic })).toThrow(/did not authenticate/);
    expect(() => open(sealed, { equipmentKey: key, equipmentId: "11111111-2222-3333-4444-555555555555", direction: "up", topic })).toThrow(/did not authenticate/);
  });

  it("refuses any flipped bit, in the header, the nonce, the body or the tag", () => {
    const sealed = seal({ x: 1, y: [1, 2, 3] }, params("up", topic, 5));
    for (let i = 0; i < sealed.length; i++) {
      const bad = Buffer.from(sealed);
      bad[i] = bad[i]! ^ 0x01;
      let failed = false;
      try {
        open(bad, { equipmentKey: key, equipmentId: id, direction: "up", topic });
      } catch {
        failed = true;
      }
      expect(failed, `byte ${i} changed but the message still opened`).toBe(true);
    }
  });

  it("refuses a short message and an unknown version", () => {
    expect(() => peekHeader(Buffer.alloc(10))).toThrow(/too short/);
    const sealed = seal({ x: 1 }, params("up", topic, 5));
    sealed[0] = 2;
    expect(() => peekHeader(sealed)).toThrow(/unknown version/);
  });

  it("refuses a key of the wrong size and a bad counter", () => {
    expect(() => seal({ x: 1 }, { ...params("up", topic, 1), equipmentKey: Buffer.alloc(16) })).toThrow(/32 bytes/);
    expect(() => seal({ x: 1 }, params("up", topic, -1))).toThrow(/32-bit/);
    expect(() => seal({ x: 1 }, params("up", topic, 2 ** 32))).toThrow(/32-bit/);
  });

  it("reports a sealed body that is not MessagePack", () => {
    const sealed = sealBytes(Buffer.from([0xc1]), params("up", topic, 1)); // 0xc1 is never valid MessagePack
    expect(() => open(sealed, { equipmentKey: key, equipmentId: id, direction: "up", topic })).toThrow(/MessagePack/);
  });

  it("stays compatible with a standard MessagePack decoder", () => {
    const sealed = seal({ a: 1 }, params("up", topic, 1));
    const raw = openBytes(sealed, { equipmentKey: key, equipmentId: id, direction: "up", topic }).body;
    expect(unpack(raw)).toEqual({ a: 1 });
  });
});

describe("rotation: more than one key active", () => {
  const topic = `wt/v1/${id}/up/data`;
  const oldKey = Buffer.alloc(32, 1);
  const newKey = Buffer.alloc(32, 2);

  it("opens a message with whichever active key sealed it and says which", () => {
    const sealedWithNew = seal({ n: 1 }, { equipmentKey: newKey, equipmentId: id, direction: "up", topic, counter: 1 });
    const sealedWithOld = seal({ n: 2 }, { equipmentKey: oldKey, equipmentId: id, direction: "up", topic, counter: 1 });
    const keys = [{ id: "old", key: oldKey }, { id: "new", key: newKey }];
    expect(openWithAnyKey(sealedWithNew, keys, { equipmentId: id, direction: "up", topic }).keyRef).toBe("new");
    expect(openWithAnyKey(sealedWithOld, keys, { equipmentId: id, direction: "up", topic }).keyRef).toBe("old");
  });

  it("refuses a key that is no longer active", () => {
    const sealedWithOld = seal({ n: 2 }, { equipmentKey: oldKey, equipmentId: id, direction: "up", topic, counter: 1 });
    expect(() => openWithAnyKey(sealedWithOld, [{ id: "new", key: newKey }], { equipmentId: id, direction: "up", topic })).toThrow(/did not authenticate/);
  });
});

describe("ReplayGuard", () => {
  it("accepts rising counters and refuses a repeat", () => {
    const g = new ReplayGuard();
    g.accept(1);
    g.accept(2);
    g.accept(10);
    expect(() => g.accept(10)).toThrow(/already used/);
    expect(() => g.accept(2)).toThrow(/already used/);
  });

  it("accepts a late, reordered message once, inside the window", () => {
    const g = new ReplayGuard();
    g.accept(100);
    g.accept(105);
    g.accept(103);
    expect(() => g.accept(103)).toThrow(/already used/);
    expect(g.highestCounter).toBe(105);
  });

  it("refuses a counter older than the window", () => {
    const g = new ReplayGuard(64);
    g.accept(1000);
    expect(() => g.accept(900)).toThrow(/too old/);
    g.accept(940);
  });

  it("starts fresh after a big jump", () => {
    const g = new ReplayGuard(64);
    g.accept(5);
    g.accept(5000);
    expect(() => g.accept(5)).toThrow(/too old/);
  });

  it("survives a restart through snapshot and restore", () => {
    const g = new ReplayGuard();
    for (const c of [1, 2, 3, 7]) g.accept(c);
    const again = ReplayGuard.restore(g.snapshot());
    expect(() => again.accept(7)).toThrow(/already used/);
    expect(() => again.accept(3)).toThrow(/already used/);
    again.accept(5);
    again.accept(8);
  });
});
