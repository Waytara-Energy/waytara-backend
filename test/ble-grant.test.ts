import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GRANT_BYTES, deriveGrantKey, makeGrant, openGrant, publicKeyHash } from "../src/core/ble-grant.js";

const v = JSON.parse(readFileSync(new URL("../test-vectors/ble-grant.json", import.meta.url), "utf8")) as {
  equipmentKeyHex: string;
  grantKeyHex: string;
  equipmentId: string;
  devicePublicKeyHex: string;
  pubHashHex: string;
  cases: { name: string; level: "network" | "service" | "admin"; userId: string; expiresAtS: number; grantHex: string }[];
};
const key = Buffer.from(v.equipmentKeyHex, "hex");
const pub = Buffer.from(v.devicePublicKeyHex, "hex");

describe("the Bluetooth grant", () => {
  it("derives the same keys and bytes as the shared vectors (the firmware checks the same file)", () => {
    expect(deriveGrantKey(key).toString("hex")).toBe(v.grantKeyHex);
    expect(publicKeyHash(pub).toString("hex")).toBe(v.pubHashHex);
    for (const c of v.cases) {
      const g = makeGrant({ equipmentKey: key, equipmentId: v.equipmentId, userId: c.userId, level: c.level, expiresAtS: c.expiresAtS, devicePublicKey: pub });
      expect(g.length).toBe(GRANT_BYTES);
      expect(g.toString("hex"), c.name).toBe(c.grantHex);
    }
  });

  const g = Buffer.from(v.cases[1]!.grantHex, "hex");
  const exp = v.cases[1]!.expiresAtS;
  const open = (grant: Buffer, over: Partial<{ equipmentKey: Buffer; equipmentId: string; devicePublicKey: Buffer; nowS: number }> = {}) =>
    openGrant(grant, { equipmentKey: key, equipmentId: v.equipmentId, devicePublicKey: pub, nowS: exp - 100, ...over });

  it("is opened by the unit that holds the key, on the connection it was made for, before it expires", () => {
    expect(open(g)).toEqual({ level: 3, expiresAtS: exp, equipmentId: v.equipmentId, userId: v.cases[1]!.userId });
  });

  it("is refused after it expired, or when it claims to last too long", () => {
    expect(open(g, { nowS: exp })).toBeNull();
    expect(open(g, { nowS: exp + 5 })).toBeNull();
    expect(open(g, { nowS: exp - 700 })).toBeNull();
  });

  it("is refused for another key, another unit, or another connection", () => {
    expect(open(g, { equipmentKey: Buffer.alloc(32, 1) })).toBeNull();
    expect(open(g, { equipmentId: "aaaaaaaa-0000-4000-8000-000000000001" })).toBeNull();
    const other = Buffer.from(pub);
    other[10] = other[10]! ^ 1;
    expect(open(g, { devicePublicKey: other })).toBeNull();
  });

  it("is refused when any byte is changed (a level cannot be raised)", () => {
    for (let i = 0; i < g.length; i++) {
      const t = Buffer.from(g);
      t[i] = t[i]! ^ 0x01;
      expect(open(t), `byte ${i}`).toBeNull();
    }
    expect(open(g.subarray(0, 61))).toBeNull();
  });
});
