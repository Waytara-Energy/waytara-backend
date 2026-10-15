/**
 * A stand-in for the Plugzmart charger, for trying the OCPP server end to end without the charger. It speaks OCPP 1.6-J the way the real
 * charger does (messages as logged on 2026-10-05: kWh and kW in meter values, phase "L1-N", ids like "00001#...").
 *
 *   SIM_URL=wss://hub.waytaraenergy.com/ocpp/<secret>/<charger name> npx tsx scripts/simulate-charger.ts [seconds] [sample seconds]
 *
 * It boots, reports Available, starts a session, sends meter values (default every 10 s for 90 s), stops, and prints what the server answers
 * and what it asked of the charger. Never prints the secret.
 */
import WebSocket from "ws";

const url = process.env.SIM_URL;
if (!url) {
  process.stderr.write("set SIM_URL to the charger's address\n");
  process.exit(1);
}
const seconds = Number(process.argv[2] ?? 90);
const every = Number(process.argv[3] ?? 10);
const say = (s: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${s}\n`);
const shown = url.replace(/\/ocpp\/[^/]+\//, "/ocpp/[hidden]/");

const ws = new WebSocket(url, "ocpp1.6");
let n = 0;
const pending = new Map<string, (m: unknown[]) => void>();
const call = (action: string, payload: unknown) =>
  new Promise<unknown[]>((resolve) => {
    const id = `${String(++n).padStart(5, "0")}#${Date.now()}`;
    pending.set(id, resolve);
    ws.send(JSON.stringify([2, id, action, payload]));
  });
ws.on("message", (data) => {
  const m = JSON.parse(data.toString()) as [number, string, ...unknown[]];
  if (m[0] === 2) {
    say(`server asks: ${String(m[2])} ${JSON.stringify(m[3])}`);
    ws.send(JSON.stringify([3, m[1], { status: "Accepted" }]));
  } else if (m[0] === 3 || m[0] === 4) {
    pending.get(m[1])?.(m);
    pending.delete(m[1]);
  }
});
ws.on("unexpected-response", (_r, res) => {
  say(`refused: HTTP ${res.statusCode}`);
  process.exit(2);
});
ws.on("error", (e) => say(`error: ${e.message}`));
await new Promise<void>((resolve) => ws.once("open", () => resolve()));
say(`connected to ${shown} (subprotocol ${ws.protocol})`);

const iso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const boot = await call("BootNotification", { chargePointSerialNumber: "SIM00001", chargePointModel: "MERDM12R01XXXX", chargePointVendor: "Plugzmart", firmwareVersion: "sim-1.0", imsi: "", iccid: "" });
say(`boot: ${JSON.stringify(boot[2])}`);
await call("StatusNotification", { connectorId: 1, status: "Available", timestamp: iso(), errorCode: "NoError", info: "" });
await call("Heartbeat", {});
const meterStartWh = 52873;
const start = await call("StartTransaction", { timestamp: iso(), idTag: "LOCAL_ADMIN", connectorId: 1, meterStart: meterStartWh });
const tx = (start[2] as { transactionId: number }).transactionId;
say(`session started: transaction ${tx}`);
await call("StatusNotification", { connectorId: 1, status: "Charging", timestamp: iso(), errorCode: "NoError", info: "" });

let kwh = meterStartWh / 1000;
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < seconds) {
  await new Promise((r) => setTimeout(r, every * 1000));
  const kw = 6.6 + Math.sin((Date.now() - t0) / 20000) * 0.8; // about 7 kW
  kwh += (kw * every) / 3600;
  const r = await call("MeterValues", {
    connectorId: 1,
    transactionId: tx,
    meterValue: [
      {
        timestamp: iso(),
        sampledValue: [
          { value: kwh.toFixed(2), context: "Sample.Periodic", format: "Raw", measurand: "Energy.Active.Import.Register", phase: "L1-N", location: "Outlet", unit: "kWh" },
          { value: kw.toFixed(2), measurand: "Power.Active.Import", phase: "L1-N", unit: "kW" },
          { value: "236.8", context: "Sample.Periodic", format: "Raw", measurand: "Voltage", phase: "L1-N", location: "Outlet", unit: "V" },
          { value: (kw * 1000 / 236.8).toFixed(2), context: "Sample.Periodic", format: "Raw", measurand: "Current.Import", phase: "L1-N", location: "Outlet", unit: "A" },
        ],
      },
    ],
  });
  say(`meter values: ${kwh.toFixed(2)} kWh, ${kw.toFixed(2)} kW -> ${r[0] === 3 ? "ok" : JSON.stringify(r)}`);
}
const stop = await call("StopTransaction", { timestamp: iso(), transactionId: tx, reason: "Local", idTag: "LOCAL_ADMIN", meterStop: Math.round(kwh * 1000) });
say(`session stopped: ${JSON.stringify(stop[2])}, ${(kwh - meterStartWh / 1000).toFixed(3)} kWh`);
await call("StatusNotification", { connectorId: 1, status: "Available", timestamp: iso(), errorCode: "NoError", info: "" });
ws.close();
