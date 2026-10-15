import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveLoginToken } from "../src/core/mqtt-login.js";

const v = JSON.parse(readFileSync(new URL("../test-vectors/mqtt-login.json", import.meta.url), "utf8")) as {
  cases: { name: string; keyHex: string; equipmentId: string; clientId: string; password: string }[];
};

describe("shared MQTT login vectors (the firmware must produce these passwords)", () => {
  for (const c of v.cases) {
    it(`${c.name}`, () => {
      const key = Buffer.from(c.keyHex, "hex");
      // computed here with plain HMAC, independent of the helper that wrote the file
      const independent = createHmac("sha256", key).update(`wt-mqtt-login/v1|${c.equipmentId}`).digest().toString("base64url");
      expect(c.password).toBe(independent);
      expect(deriveLoginToken(key, c.equipmentId)).toBe(c.password);
      expect(c.password).toHaveLength(43);
      expect(c.clientId).toBe(`gw-${c.equipmentId}`);
    });
  }

  it("differs per equipment and per key", () => {
    const k = Buffer.alloc(32, 1);
    expect(deriveLoginToken(k, v.cases[0]!.equipmentId)).not.toBe(deriveLoginToken(k, v.cases[1]!.equipmentId));
    expect(deriveLoginToken(Buffer.alloc(32, 2), v.cases[0]!.equipmentId)).not.toBe(deriveLoginToken(k, v.cases[0]!.equipmentId));
  });

  it("refuses a key of the wrong length", () => {
    expect(() => deriveLoginToken(Buffer.alloc(16), "x")).toThrow();
  });
});
