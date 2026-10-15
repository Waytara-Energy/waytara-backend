/**
 * Regenerates test-vectors/mqtt-login.json (the password a board presents to the broker). Run only when the derivation is changed on
 * purpose:
 *   npx tsx scripts/make-mqtt-login-vectors.ts
 * The firmware must be changed to match and its self-test run against the new file.
 */
import { writeFileSync } from "node:fs";
import { deriveLoginToken } from "../src/core/mqtt-login.js";

const cases = [
  { name: "ascending key", key: Uint8Array.from({ length: 32 }, (_, i) => i), equipmentId: "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2" },
  { name: "descending key", key: Uint8Array.from({ length: 32 }, (_, i) => 0xff - i), equipmentId: "aaaaaaaa-0000-4000-8000-000000000001" },
  { name: "repeated byte key", key: new Uint8Array(32).fill(0x5a), equipmentId: "00000000-0000-4000-8000-000000000000" },
];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

writeFileSync(
  new URL("../test-vectors/mqtt-login.json", import.meta.url),
  JSON.stringify(
    {
      about:
        "The MQTT password of a board: base64url (no padding) of HMAC-SHA-256 with the 32-byte equipment key as the HMAC key over the UTF-8 text 'wt-mqtt-login/v1|<equipmentId>'. User name = equipment id, client id = 'gw-<equipmentId>'.",
      message: "wt-mqtt-login/v1|<equipmentId>",
      cases: cases.map((c) => ({ name: c.name, keyHex: hex(c.key), equipmentId: c.equipmentId, clientId: `gw-${c.equipmentId}`, password: deriveLoginToken(c.key, c.equipmentId) })),
    },
    null,
    2,
  ) + "\n",
);
