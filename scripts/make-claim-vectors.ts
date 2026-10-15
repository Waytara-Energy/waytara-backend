/**
 * Regenerates test-vectors/claim.json (the box a board opens to receive its key). Run only when the format is changed on purpose:
 *   npx tsx scripts/make-claim-vectors.ts
 * The firmware must be changed to match and its self-test run against the new file.
 */
import { createECDH } from "node:crypto";
import { writeFileSync } from "node:fs";
import { CLAIM_ALG, eciesEncrypt } from "../src/core/ecies.js";

const boardPrivate = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const ephemeralPrivate = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const nonce = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
const equipmentKey = Uint8Array.from({ length: 32 }, (_, i) => 0xff - i);
const equipmentId = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const hardwareId = "A1B2C3D4E5F6";
const context = `${equipmentId}|${hardwareId}`;

const board = createECDH("prime256v1");
board.setPrivateKey(Buffer.from(boardPrivate));
const boardPublic = board.getPublicKey();
const box = eciesEncrypt(boardPublic, equipmentKey, context, { ephemeralPrivateKey: ephemeralPrivate, nonce });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

writeFileSync(
  new URL("../test-vectors/claim.json", import.meta.url),
  JSON.stringify(
    {
      about:
        "What a board receives when it collects its key. ECDH P-256 (ephemeral key of the server, public key of the board), HKDF-SHA-256 (salt = ephemeral public key || board public key, info = 'waytara/v1/claim'), AES-256-GCM (AAD = context). Public keys are 65-byte uncompressed points.",
      alg: CLAIM_ALG,
      context,
      boardPrivateKeyHex: hex(boardPrivate),
      boardPublicKeyHex: hex(boardPublic),
      ephemeralPrivateKeyHex: hex(ephemeralPrivate),
      nonceHex: hex(nonce),
      equipmentKeyHex: hex(equipmentKey),
      serverPublicKeyHex: hex(box.ephemeralPublicKey),
      ciphertextWithTagHex: hex(box.ciphertext),
    },
    null,
    1,
  ),
);
process.stdout.write("wrote claim vector\n");
