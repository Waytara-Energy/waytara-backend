/**
 * Regenerates test-vectors/ble-grant.json (the Bluetooth grant a unit checks by itself). Run only when the format is changed on purpose:
 *   npx tsx scripts/make-ble-grant-vectors.ts
 * The firmware must be changed to match and its self-test run against the new file.
 */
import { writeFileSync } from "node:fs";
import { deriveGrantKey, makeGrant, publicKeyHash, type LevelName } from "../src/core/ble-grant.js";

const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const pub = Uint8Array.from([0x04, ...Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff)]);
const equipmentId = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const cases: { name: string; level: LevelName; userId: string; expiresAtS: number }[] = [
  { name: "customer, network level", level: "network", userId: "c1000000-0000-4000-8000-000000000001", expiresAtS: 1_792_044_120 },
  { name: "engineer, service level", level: "service", userId: "e1000000-0000-4000-8000-000000000002", expiresAtS: 1_792_044_120 },
  { name: "admin", level: "admin", userId: "a0000000-0000-4000-8000-000000000003", expiresAtS: 1_792_044_120 },
];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

writeFileSync(
  new URL("../test-vectors/ble-grant.json", import.meta.url),
  JSON.stringify(
    {
      about:
        "The Bluetooth grant: payload = version(1)=1 level(1) expires(4, big endian unix seconds) pubHash(8) equipmentId(16) userId(16); grant = payload + first 16 bytes of HMAC-SHA-256(grantKey, payload); grantKey = HMAC-SHA-256(equipment key, 'wt-ble-grant-key/v1'); pubHash = first 8 bytes of SHA-256(the unit's 65-byte public key for the connection). Levels: 1 view, 2 network, 3 service, 4 admin.",
      equipmentKeyHex: hex(key),
      grantKeyHex: hex(deriveGrantKey(key)),
      equipmentId,
      devicePublicKeyHex: hex(pub),
      pubHashHex: hex(publicKeyHash(pub)),
      cases: cases.map((c) => ({ name: c.name, level: c.level, userId: c.userId, expiresAtS: c.expiresAtS, grantHex: hex(makeGrant({ equipmentKey: key, equipmentId, userId: c.userId, level: c.level, expiresAtS: c.expiresAtS, devicePublicKey: pub })) })),
    },
    null,
    2,
  ) + "\n",
);
