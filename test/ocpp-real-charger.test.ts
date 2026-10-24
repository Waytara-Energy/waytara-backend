import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_S } from "../src/features/ocpp/connection.js";
import { OcppBridge } from "../src/features/ocpp/bridge.js";
import { OcppHub } from "../src/features/ocpp/hub.js";
import { FakeEvStore } from "./fake-ev-store.js";

/**
 * What a REAL charger sends. The frames are what a Plugzmart 7.4kW AC charger (firmware 2.2.7, charge point WT_PZ_7k_1) sent to the user's own
 * Python OCPP server on 2026-10-05: the first boot, then one full charge (about 0.85 kWh at 6.9 kW, stopped remotely). They are replayed
 * word for word through the backend's real OCPP engine, by way of the monitoring-unit bridge, with a clock that follows the log so that the
 * frames' own times are "now". Nothing here is skipped: every call must be answered, and answered with a result, not an error.
 */

interface Fixture {
  chargePoint: string;
  frames: { at: string; raw: string }[];
}
const fx = JSON.parse(readFileSync(new URL("./fixtures/real-plugzmart-charge.json", import.meta.url), "utf8")) as Fixture;

const GW = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const CH = "6a27a6ba-ea07-4b30-a3ae-7f2c9d90e127";
const quiet = { info: () => undefined, warn: () => undefined };

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function replay() {
  const ev = new FakeEvStore();
  ev.bindings.set(`${GW}|${fx.chargePoint}`, { equipmentId: CH, chargePointId: fx.chargePoint, label: "Plugzmart 7.4kW" });
  let clock = Date.parse(fx.frames[0]!.at);
  const hub = new OcppHub({ store: ev, log: quiet, now: () => clock });
  const answers = new Map<string, unknown[]>();
  const serverCalls: { action: string; payload: unknown }[] = [];
  const bridge: OcppBridge = new OcppBridge({
    hub,
    store: ev,
    // the hub's answers come here; its own calls (it configures a charger when it boots) are answered as a charger that accepts everything would
    send: async (_id, body) => {
      if (body.t !== "frame") return true;
      const m = JSON.parse(String(body.f)) as unknown[];
      if (m[0] === 2) {
        serverCalls.push({ action: String(m[2]), payload: m[3] });
        setImmediate(() => void bridge.onUp(GW, { t: "frame", cp: fx.chargePoint, f: JSON.stringify([3, m[1], { status: "Accepted" }]) }));
      } else {
        answers.set(String(m[1]), m);
      }
      return true;
    },
    alive: () => true,
    log: quiet,
  });

  await bridge.onUp(GW, { t: "open", cp: fx.chargePoint });
  await until(() => !!hub.get(CH));
  const calls: { id: string; action: string; payload: Record<string, unknown> }[] = [];
  // A charger echoes the transaction number its server gave it. The Python server gave this charger 1003; the backend gives its own, so the later
  // frames carry the number from the backend's StartTransaction answer, exactly as the real charger would send them.
  let issued: number | null = null;
  for (const f of fx.frames) {
    clock = Date.parse(f.at);
    const m = JSON.parse(f.raw) as [number, string, string, Record<string, unknown>];
    if (issued !== null && "transactionId" in m[3]) m[3] = { ...m[3], transactionId: issued };
    calls.push({ id: m[1], action: m[2], payload: m[3] });
    await bridge.onUp(GW, { t: "frame", cp: fx.chargePoint, f: JSON.stringify(m) });
    await until(() => answers.has(m[1])); // one at a time, as a charger waits for each answer
    if (m[2] === "StartTransaction") issued = (answers.get(m[1])![2] as { transactionId: number }).transactionId;
  }
  return { ev, hub, bridge, answers, calls, serverCalls };
}

describe("a real Plugzmart charge, replayed through the OCPP server", () => {
  it("starts from real frames (not an empty file) and covers a whole charge", () => {
    const actions = new Set(fx.frames.map((f) => (JSON.parse(f.raw) as unknown[])[2]));
    for (const a of ["BootNotification", "StatusNotification", "Heartbeat", "StartTransaction", "MeterValues", "StopTransaction"]) expect(actions.has(a), a).toBe(true);
    expect(fx.frames.length).toBeGreaterThan(40);
  });

  it("answers every call with a result and none with an error", async () => {
    const { answers, calls } = await replay();
    const refused = calls.filter((c) => answers.get(c.id)?.[0] !== 3).map((c) => ({ action: c.action, id: c.id, answer: answers.get(c.id) }));
    expect(refused).toEqual([]);
    expect(calls.length).toBe(fx.frames.length);
  });

  it("accepts the boot, tells the charger how often to check in, and notes the charger's check-ins", async () => {
    const { answers, calls, ev } = await replay();
    const boot = calls.find((c) => c.action === "BootNotification")!;
    expect(answers.get(boot.id)![2]).toMatchObject({ status: "Accepted", interval: HEARTBEAT_INTERVAL_S });
    expect(ev.heartbeats.length).toBeGreaterThan(0);
    expect(ev.heartbeats.every((h) => h.equipmentId === CH)).toBe(true);
    const bootEvent = ev.events.find((e) => e.kind === "boot");
    expect(bootEvent?.detail).toMatchObject({ vendor: "Plugzmart", model: "MERDM12R01XXXX", serial: "ME250004", firmware: "2.2.7" });
  });

  it("records the connector's journey: Available, Preparing, Charging, Finishing (with the charger's own error code), Available", async () => {
    const { ev } = await replay();
    const status = ev.events.filter((e) => e.kind === "status").map((e) => `${String(e.detail.status)}/${String(e.detail.error)}`);
    // (a status that did not change is not written twice)
    expect(status).toEqual(["Available/NoError", "Preparing/NoError", "Charging/NoError", "Finishing/OtherError", "Available/NoError"]);
    // the real charger writes a JSON text in "info" ("{}" or {"stopReason":"EvStopped"}): kept short, not dropped silently
    expect(ev.events.some((e) => e.kind === "status" && typeof e.detail.info === "string" && String(e.detail.info).includes("stopReason"))).toBe(true);
  });

  it("makes one session with the charger's own meter figures and stops it when the charger stops it", async () => {
    const { ev } = await replay();
    expect(ev.sessions).toHaveLength(1);
    const s = ev.sessions[0]!;
    expect(s).toMatchObject({ equipmentId: CH, connector: 1, meterStartWh: 52874, meterStopWh: 53724, reason: "Remote", chargePoint: fx.chargePoint });
    expect(s.endedAt).not.toBeNull();
    expect(s.summary?.status).toBe("completed");
    // 0.85 kWh at about 6.9 kW, with the charge at 30 A
    expect((s.meterStopWh! - s.meterStartWh) / 1000).toBeCloseTo(0.85, 2);
    expect(s.summary?.peak_power_kw).toBeGreaterThan(6.5);
    expect(s.summary?.peak_power_kw).toBeLessThan(7.5);
    expect(s.summary?.max_current_a).toBeGreaterThan(29);
  });

  it("stores every meter reading of the charge with power, current, voltage and energy (kWh in, kWh out)", async () => {
    const { ev } = await replay();
    const sessionId = ev.sessions[0]!.id;
    const samples = ev.samples.filter((x) => x.sessionId === sessionId).map((x) => x.sample as Record<string, number | undefined>);
    expect(samples.length).toBeGreaterThanOrEqual(8);
    for (const s of samples) {
      expect(typeof s.power_kw).toBe("number");
      expect(typeof s.current_a_l1).toBe("number");
      expect(s.voltage_v_l1).toBeGreaterThan(200);
      expect(s.voltage_v_l1).toBeLessThan(260);
      expect(s.energy_kwh).toBeGreaterThan(50); // the charger's register is a lifetime total: 52.9 to 53.7 kWh
    }
    expect(Math.max(...samples.map((s) => s.power_kw ?? 0))).toBeGreaterThan(6.5);
    expect(Math.max(...samples.map((s) => s.energy_kwh ?? 0))).toBeCloseTo(53.72, 1);
  });

  it("keeps the dashboard's live figures: the connector state, then power, current, voltage and energy, and zero power when the charge ends", async () => {
    const { ev } = await replay();
    const all = ev.latestValues.filter((x) => x.equipmentId === CH);
    expect(all.length).toBeGreaterThan(8);
    expect(all.some((x) => x.values.connector_status?.v === 2)).toBe(true); // Charging
    expect(all.at(0)?.values.connector_status?.v).toBe(0); // the first thing it says is Available
    const meter = all.filter((x) => x.values.power_active_import_kw && x.values.power_active_import_kw.v > 6.5);
    expect(meter.length).toBeGreaterThan(3);
    expect(meter[0]!.values.voltage_l1_n_v!.v).toBeGreaterThan(200);
    expect(meter[0]!.values.energy_active_import_register_kwh!.u).toBe("kWh");
    expect(all.at(-1)?.values.connector_status?.v).toBe(0); // and the last is Available again
    expect(all.some((x) => x.values.power_active_import_kw?.v === 0)).toBe(true);
  });

  it("does not lose frames that carry the charger's quirks (empty strings, kWh energy but Wh meter start, old status times)", async () => {
    const { calls, answers } = await replay();
    const boot = calls.find((c) => c.action === "BootNotification")!;
    expect(boot.payload.imsi).toBe(""); // an empty text, not missing
    const start = calls.find((c) => c.action === "StartTransaction")!;
    expect(Number.isInteger(start.payload.meterStart)).toBe(true); // Wh, as a whole number, while the meter values say kWh
    const startAnswer = answers.get(start.id)![2] as { transactionId: number; idTagInfo: { status: string } };
    expect(startAnswer.idTagInfo.status).toBe("Accepted");
    expect(Number.isInteger(startAnswer.transactionId)).toBe(true);
    // the meter values and the stop carry the transaction id the hub gave in that answer
    const used = new Set(calls.filter((c) => c.action === "MeterValues" || c.action === "StopTransaction").map((c) => c.payload.transactionId));
    expect(used.size).toBe(1);
  });

  it("configures the charger when it boots: the settings the hub sends are listed so a charger that refuses them is noticed", async () => {
    const { serverCalls } = await replay();
    const keys = serverCalls.filter((c) => c.action === "ChangeConfiguration").map((c) => (c.payload as { key: string }).key);
    // The real charger was only ever run by the Python server, which never sent a ChangeConfiguration: how this charger answers them is not known
    // yet. This test answers "Accepted" for them and only pins WHAT the hub asks for.
    expect(keys).toEqual(["MeterValueSampleInterval", "MeterValuesSampledData", "HeartbeatInterval"]);
  });
});
