/**
 * A stand-in for the monitoring board, for trying the backend end to end without hardware:
 *
 *   SIM_URL=wss://hub.waytaraenergy.com/mqtt SIM_EQUIPMENT_ID=<uuid> SIM_KEY_FILE=<file with the base64url key> \
 *     npx tsx scripts/simulate-board.ts [seconds]
 *
 * It logs in the way the firmware will, takes the register map from dn/map, sends raw register words in sealed batches every 30 s
 * and a check-in every 10 s, and prints what the backend answers (map versions, acknowledgements). It never prints the key.
 * Values are fixed: PV1 power 120 W (register 186), battery 80 % (184), battery power 0 (190), the rest zero.
 */
import { readFileSync } from "node:fs";
import mqtt from "mqtt";
import { deriveLoginToken } from "../src/core/mqtt-login.js";
import { open, seal } from "../src/core/seal.js";
import { dnTopic, upTopic } from "../src/features/broker/topics.js";

const url = process.env.SIM_URL;
const equipmentId = process.env.SIM_EQUIPMENT_ID;
const keyFile = process.env.SIM_KEY_FILE;
if (!url || !equipmentId || !keyFile) {
  process.stderr.write("set SIM_URL, SIM_EQUIPMENT_ID and SIM_KEY_FILE\n");
  process.exit(1);
}
const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64url");
const seconds = Number(process.argv[2] ?? 240);
const say = (s: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${s}\n`);

const WORDS: Record<number, number> = { 186: 120, 184: 80, 190: 0 };
const boot = Math.floor(Date.now() / 1000) % 1_000_000;
let counter = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000) * 8; // above anything an earlier run used
let seq = 1;
let requests: { s: number; n: number; c: number }[] = [];
let mapVer = 0;
let lastAck = -1;
const pending: { t: number; seq: number; blocks: [number, number[]][] }[] = [];

const up = (name: "data" | "hb" | "evt", body: unknown) => seal(body, { equipmentKey: key, equipmentId, direction: "up", topic: upTopic(equipmentId, name), counter: ++counter });

const client = await mqtt.connectAsync(url, {
  clientId: `gw-${equipmentId}`,
  username: equipmentId,
  password: deriveLoginToken(key, equipmentId),
  protocolVersion: 4,
  reconnectPeriod: 0,
  connectTimeout: 10_000,
  will: { topic: upTopic(equipmentId, "state"), payload: Buffer.from("offline"), qos: 1, retain: true },
});
say("connected");

client.on("message", (topic, payload) => {
  const name = topic.split("/").pop() as "map" | "ack" | "cmd";
  try {
    const body = open<Record<string, unknown>>(payload, { equipmentKey: key, equipmentId, direction: "dn", topic: dnTopic(equipmentId, name) }).body;
    if (name === "map") {
      requests = body.requests as typeof requests;
      mapVer = body.ver as number;
      say(`register map v${mapVer}: ${requests.length} requests, ${(body.writes as unknown[]).length} writable registers`);
    } else if (name === "ack") {
      lastAck = body.seq as number;
      say(`acknowledged up to frame ${lastAck}`);
    } else say(`command ${JSON.stringify(body).slice(0, 80)}`);
  } catch (error) {
    say(`could not open a ${name} message: ${error instanceof Error ? error.message : String(error)}`);
  }
});
await client.subscribeAsync([dnTopic(equipmentId, "map"), dnTopic(equipmentId, "ack"), dnTopic(equipmentId, "cmd")], { qos: 1 });
await client.publishAsync(upTopic(equipmentId, "state"), "online", { qos: 1, retain: true });
await client.publishAsync(upTopic(equipmentId, "evt"), Buffer.from(up("evt", { type: "hello", fw_version: "sim-1.0", hardware_id: "SIMULATED0001", map_ver: mapVer })), { qos: 1 });

const readFrame = () => ({
  t: Date.now(),
  seq: seq++,
  blocks: requests.map((r): [number, number[]] => [r.s, Array.from({ length: r.n }, (_, i) => WORDS[r.s + i] ?? 0)]),
});
const frameTimer = setInterval(() => {
  if (requests.length > 0) pending.push(readFrame());
}, 5000);
const sendTimer = setInterval(() => {
  const frames = pending.filter((f) => f.seq > lastAck);
  if (frames.length === 0) return;
  void client.publishAsync(upTopic(equipmentId, "data"), up("data", { boot, seq_first: frames[0]!.seq, seq_last: frames.at(-1)!.seq, map_ver: mapVer, frames }), { qos: 1 });
  say(`sent frames ${frames[0]!.seq}..${frames.at(-1)!.seq}`);
}, 30_000);
const hbTimer = setInterval(() => {
  void client.publishAsync(upTopic(equipmentId, "hb"), up("hb", { boot, uptime_s: Math.round(process.uptime()), inverter_online: true, last_modbus_ok_age_s: 1, map_ver: mapVer, fw_version: "sim-1.0", rssi: -55, queue_frames: pending.length, ...(lastAck >= 0 ? { seq_acked: lastAck } : {}), clock_valid: true, device_time_ms: Date.now() }), { qos: 1 });
}, 10_000);

await new Promise((r) => setTimeout(r, seconds * 1000));
clearInterval(frameTimer);
clearInterval(sendTimer);
clearInterval(hbTimer);
say(`done: sent ${seq - 1} frames, acknowledged up to ${lastAck}`);
await client.endAsync();
