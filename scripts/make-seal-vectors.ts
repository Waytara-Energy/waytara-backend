/**
 * Regenerates test-vectors/seal.json. Run only when the envelope format is changed on purpose:
 *   npx tsx scripts/make-seal-vectors.ts
 * The firmware must then be changed to match and its self-test run against the new file.
 */
import { writeFileSync } from "node:fs";
import { encode as pack } from "@msgpack/msgpack";
import { deriveKey, keyIdOf, sealBytes } from "../src/core/seal.js";

const equipmentKey = Uint8Array.from({ length: 32 }, (_, i) => i);
const equipmentId = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const cases = [
  {
    name: "gateway data batch (up)",
    direction: "up" as const,
    topic: `wt/v1/${equipmentId}/up/data`,
    counter: 7,
    nonce: Uint8Array.from({ length: 12 }, (_, i) => i + 1),
    body: { boot: 12345, seq_first: 1, seq_last: 2, map_ver: 3, frames: [{ t: 1792044000000, seq: 1, blocks: [[186, [120]], [190, [65476]]] }, { t: 1792044005000, seq: 2, blocks: [[186, [125]]] }] },
  },
  {
    name: "acknowledgement (dn)",
    direction: "dn" as const,
    topic: `wt/v1/${equipmentId}/dn/ack`,
    counter: 4294967295,
    nonce: Uint8Array.from({ length: 12 }, (_, i) => 0xf0 + i),
    body: { boot: 12345, seq: 2 },
  },
];

const vectors = cases.map((c) => {
  const plaintext = pack(c.body);
  const sealed = sealBytes(plaintext, { equipmentKey, equipmentId, direction: c.direction, topic: c.topic, counter: c.counter, nonce: c.nonce });
  return {
    name: c.name,
    direction: c.direction,
    topic: c.topic,
    counter: c.counter,
    nonceHex: hex(c.nonce),
    derivedKeyHex: hex(deriveKey(equipmentKey, equipmentId, c.direction)),
    plaintextMsgpackHex: hex(plaintext),
    sealedHex: hex(sealed),
  };
});

writeFileSync(
  new URL("../test-vectors/seal.json", import.meta.url),
  JSON.stringify(
    {
      about:
        "Shared proof that the backend and the firmware seal messages identically. Layout: version(1) keyId(2) counter(4 BE) nonce(12) ciphertext tag(16). AES-256-GCM, key = HKDF-SHA-256(ikm = equipment key, salt = 'waytara/v1/seal', info = '<equipmentId>/<direction>'), AAD = first 7 header bytes + topic (UTF-8).",
      equipmentKeyHex: hex(equipmentKey),
      equipmentId,
      keyIdHex: keyIdOf(equipmentKey).toString(16).padStart(4, "0"),
      vectors,
    },
    null,
    1,
  ),
);
process.stdout.write(`wrote ${vectors.length} vectors\n`);
