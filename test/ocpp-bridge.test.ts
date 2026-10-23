import { describe, expect, it } from "vitest";
import { OcppBridge } from "../src/features/ocpp/bridge.js";
import { OcppHub } from "../src/features/ocpp/hub.js";
import { FakeEvStore } from "./fake-ev-store.js";

const GW = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const CH = "6a27a6ba-ea07-4b30-a3ae-7f2c9d90e127";
const quiet = { info: () => undefined, warn: () => undefined };

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(alive = true) {
  const ev = new FakeEvStore();
  ev.bindings.set(`${GW}|CP1`, { equipmentId: CH, chargePointId: "CP1", label: "Charger" });
  const hub = new OcppHub({ store: ev, log: quiet });
  const down: Record<string, unknown>[] = [];
  const state = { alive };
  const bridge = new OcppBridge({ hub, store: ev, send: async (_id, body) => (down.push(body), true), alive: () => state.alive, log: quiet });
  return { ev, hub, bridge, down, state };
}

describe("a charger on a unit's own Wi-Fi", () => {
  it("is answered by the OCPP server through the unit", async () => {
    const { bridge, down, hub, ev } = setup();
    await bridge.onUp(GW, { t: "open", cp: "CP1" });
    await until(() => !!hub.get(CH));
    await bridge.onUp(GW, { t: "frame", cp: "CP1", f: JSON.stringify([2, "b1", "BootNotification", { chargePointVendor: "Plugzmart", chargePointModel: "7.4kW" }]) });
    await until(() => down.some((m) => m.t === "frame" && String(m.f).includes('"b1"')));
    const reply = JSON.parse(String(down.find((m) => m.t === "frame" && String(m.f).includes('"b1"'))!.f)) as unknown[];
    expect(reply[0]).toBe(3);
    expect((reply[2] as { status: string }).status).toBe("Accepted");
    expect(bridge.connected(GW)).toEqual(["CP1"]);
    // the charger's check-in reaches the same status the dashboard reads
    await until(() => ev.heartbeats.length > 0);
    expect(ev.heartbeats[0]!.equipmentId).toBe(CH);
  });

  it("can be commanded from the hub (a call goes down to the unit as a frame)", async () => {
    const { bridge, down, hub } = setup();
    await bridge.onUp(GW, { t: "open", cp: "CP1" });
    await until(() => !!hub.get(CH));
    const pending = hub.get(CH)!.call("RemoteStartTransaction", { connectorId: 1, idTag: "WAYTARA" });
    await until(() => down.some((m) => m.t === "frame" && String(m.f).includes("RemoteStartTransaction")));
    const call = JSON.parse(String(down.find((m) => String(m.f).includes("RemoteStartTransaction"))!.f)) as unknown[];
    await bridge.onUp(GW, { t: "frame", cp: "CP1", f: JSON.stringify([3, call[1], { status: "Accepted" }]) });
    expect(await pending).toMatchObject({ status: "Accepted" });
  });

  it("is refused when it was not added to this unit", async () => {
    const { bridge, down, hub } = setup();
    await bridge.onUp(GW, { t: "open", cp: "STRANGER" });
    expect(down).toEqual([{ t: "close", cp: "STRANGER", why: "unknown charger" }]);
    expect(hub.get(CH)).toBeUndefined();
  });

  it("goes away with the unit and when the charger leaves", async () => {
    const { bridge, hub, state } = setup();
    await bridge.onUp(GW, { t: "open", cp: "CP1" });
    await until(() => !!hub.get(CH));
    await bridge.onUp(GW, { t: "close", cp: "CP1" });
    await until(() => !hub.get(CH));
    expect(bridge.connected(GW)).toEqual([]);

    await bridge.onUp(GW, { t: "open", cp: "CP1" });
    await until(() => !!hub.get(CH));
    state.alive = false;
    bridge.tick();
    await until(() => !hub.get(CH));
  });

  it("ignores messages of the wrong shape", async () => {
    const { bridge, down } = setup();
    await bridge.onUp(GW, { t: "nonsense", cp: "CP1" });
    await bridge.onUp(GW, { t: "open", cp: "bad name with spaces" });
    expect(down).toEqual([]);
  });
});
