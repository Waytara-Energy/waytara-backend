import { describe, expect, it } from "vitest";
import { normalizeSample } from "../src/features/ocpp/measurands.js";
import { ACTIONS } from "../src/features/ocpp/schemas.js";
import { splitSample, summarize, type StoredSample } from "../src/features/ocpp/split.js";

describe("meter values from the real Plugzmart charger", () => {
  // as logged on 2026-10-05 (energy in kWh, power in kW, phase "L1-N")
  const real = [
    { value: "52.87", context: "Sample.Periodic", format: "Raw", measurand: "Energy.Active.Import.Register", phase: "L1-N", location: "Outlet", unit: "kWh" },
    { value: "0.00", measurand: "Power.Active.Import", phase: "L1-N", unit: "kW" },
    { value: "237.49", context: "Sample.Periodic", format: "Raw", measurand: "Voltage", phase: "L1-N", location: "Outlet", unit: "V" },
    { value: "0.01", context: "Sample.Periodic", format: "Raw", measurand: "Current.Import", phase: "L1-N", location: "Outlet", unit: "A" },
  ];

  it("reads the units the charger sends", () => {
    expect(normalizeSample(real)).toEqual({ energy_kwh: 52.87, power_kw: 0, voltage_v_l1: 237.49, current_a_l1: 0.01 });
  });

  it("converts by the unit, and uses the OCPP defaults (Wh and W) when none is given", () => {
    expect(normalizeSample([{ value: "52873", measurand: "Energy.Active.Import.Register" }, { value: "7200", measurand: "Power.Active.Import" }])).toEqual({ energy_kwh: 52.873, power_kw: 7.2 });
    expect(normalizeSample([{ value: "52873", unit: "Wh" }])).toEqual({ energy_kwh: 52.873 }); // no measurand: the energy register
    expect(normalizeSample([{ value: "7.2", measurand: "Power.Active.Import", unit: "kW" }])).toEqual({ power_kw: 7.2 });
  });

  it("leaves out what was not reported and what is not a number", () => {
    expect(normalizeSample([{ value: "abc", measurand: "Voltage" }, { value: "", measurand: "Current.Import" }])).toEqual({});
    expect(normalizeSample([])).toEqual({});
  });

  it("keeps three phases apart, adds phase powers when there is no total, and ignores phase-to-phase voltage", () => {
    const s = normalizeSample([
      { value: "230", measurand: "Voltage", phase: "L1-N" },
      { value: "231", measurand: "Voltage", phase: "L2-N" },
      { value: "232", measurand: "Voltage", phase: "L3-N" },
      { value: "400", measurand: "Voltage", phase: "L1-L2" },
      { value: "10", measurand: "Current.Import", phase: "L1" },
      { value: "11", measurand: "Current.Import", phase: "L2" },
      { value: "12", measurand: "Current.Import", phase: "L3" },
      { value: "2.3", measurand: "Power.Active.Import", phase: "L1", unit: "kW" },
      { value: "2.4", measurand: "Power.Active.Import", phase: "L2", unit: "kW" },
      { value: "2.5", measurand: "Power.Active.Import", phase: "L3", unit: "kW" },
    ]);
    expect(s).toMatchObject({ voltage_v_l1: 230, voltage_v_l2: 231, voltage_v_l3: 232, current_a_l1: 10, current_a_l2: 11, current_a_l3: 12, power_kw: 7.2 });
  });

  it("prefers a total power over the sum of phases", () => {
    expect(normalizeSample([{ value: "7.4", measurand: "Power.Active.Import", unit: "kW" }, { value: "1", measurand: "Power.Active.Import", phase: "L1", unit: "kW" }]).power_kw).toBe(7.4);
  });

  it("handles charge percentage, temperature in other units, frequency and power factor; refuses impossible values", () => {
    expect(normalizeSample([{ value: "64", measurand: "SoC" }, { value: "104", measurand: "Temperature", unit: "Fahrenheit" }, { value: "50.02", measurand: "Frequency" }, { value: "0.98", measurand: "Power.Factor" }])).toEqual({
      soc_pct: 64,
      temperature_c: 40,
      frequency_hz: 50.02,
      power_factor: 0.98,
    });
    expect(normalizeSample([{ value: "140", measurand: "SoC" }, { value: "-5", measurand: "Energy.Active.Import.Register", unit: "kWh" }])).toEqual({});
  });
});

describe("the OCPP message schemas", () => {
  it("accepts what the real charger sent", () => {
    expect(ACTIONS.BootNotification.safeParse({ chargePointSerialNumber: "ME250004", chargePointModel: "MERDM12R01XXXX", chargePointVendor: "Plugzmart", firmwareVersion: "2.2.7", imsi: "", iccid: "" }).success).toBe(true);
    expect(ACTIONS.StatusNotification.safeParse({ connectorId: 1, status: "Available", timestamp: "2026-10-05T12:18:46Z", errorCode: "NoError", info: "" }).success).toBe(true);
    expect(ACTIONS.StartTransaction.safeParse({ timestamp: "2026-10-05T12:27:46Z", idTag: "LOCAL_ADMIN", connectorId: 1, meterStart: 52873 }).success).toBe(true);
    expect(ACTIONS.StopTransaction.safeParse({ timestamp: "2026-10-05T12:28:07Z", transactionId: 1001, reason: "Local", idTag: "LOCAL_ADMIN", meterStop: 52873, transactionData: [{ timestamp: "2026-10-05T12:27:46Z", sampledValue: [{ value: "52.87", unit: "kWh" }] }] }).success).toBe(true);
    expect(ACTIONS.Heartbeat.safeParse({}).success).toBe(true);
  });

  it("refuses what the specification does not allow", () => {
    expect(ACTIONS.StartTransaction.safeParse({ connectorId: 0, idTag: "x", meterStart: 0, timestamp: "2026-10-05T12:27:46Z" }).success).toBe(false);
    expect(ACTIONS.StartTransaction.safeParse({ connectorId: 1, idTag: "x".repeat(21), meterStart: 0, timestamp: "2026-10-05T12:27:46Z" }).success).toBe(false);
    expect(ACTIONS.StatusNotification.safeParse({ connectorId: 1, status: "Exploding", errorCode: "NoError" }).success).toBe(false);
    expect(ACTIONS.MeterValues.safeParse({ connectorId: 1, meterValue: [] }).success).toBe(false);
    expect(ACTIONS.BootNotification.safeParse({ chargePointVendor: "", chargePointModel: "x" }).success).toBe(false);
  });
});

describe("where the energy came from", () => {
  it("takes solar first, then the battery, then the grid", () => {
    // 3 kW house load incl. the car's 2 kW; 2.5 kW of solar, battery idle, 0.5 kW from the grid
    expect(splitSample(2000, { pv_w: 2500, battery_w: 0, grid_w: 500, load_w: 3000 })).toEqual({ ev_from_solar_w: 2000, ev_from_battery_w: 0, ev_from_grid_w: 0 });
    // a 7 kW car with little solar: solar pool 1000, battery pool 2000, the rest from the grid
    expect(splitSample(7000, { pv_w: 1000, battery_w: 2000, grid_w: 4500, load_w: 7500 })).toEqual({ ev_from_solar_w: 1000, ev_from_battery_w: 2000, ev_from_grid_w: 4000 });
  });

  it("never gives the car more solar than is being made, or more than the house uses", () => {
    expect(splitSample(3000, { pv_w: 800, battery_w: 0, grid_w: 2500, load_w: 3300 })?.ev_from_solar_w).toBe(800);
    expect(splitSample(3000, { pv_w: 9000, battery_w: 0, grid_w: 0, load_w: 3000 })).toEqual({ ev_from_solar_w: 3000, ev_from_battery_w: 0, ev_from_grid_w: 0 });
  });

  it("adds up to the car's power", () => {
    for (const site of [{ pv_w: 100, battery_w: -400, grid_w: 6000, load_w: 6100 }, { pv_w: 5000, battery_w: 3000, grid_w: -1000, load_w: 7000 }]) {
      const s = splitSample(5000, site)!;
      expect(s.ev_from_solar_w + s.ev_from_battery_w + s.ev_from_grid_w).toBe(5000);
    }
  });

  it("says nothing when it does not know enough", () => {
    expect(splitSample(3000, null)).toBeNull();
    expect(splitSample(0, { pv_w: 1, battery_w: 1, grid_w: 1, load_w: 1 })).toBeNull();
    expect(splitSample(3000, { pv_w: null, battery_w: null, grid_w: null, load_w: 3000 })).toBeNull();
    expect(splitSample(3000, { pv_w: 1000, battery_w: 0, grid_w: 0, load_w: null })).toBeNull();
  });
});

describe("the summary of a session", () => {
  const T0 = 1_792_000_000;
  const sample = (i: number, kw: number, split?: [number, number, number]): StoredSample => ({
    ts: T0 + i * 30, power_kw: kw, current_a: Math.round(kw * 4.3), has_site: !!split,
    solar_w: split?.[0] ?? null, battery_w: split?.[1] ?? null, grid_w: split?.[2] ?? null,
  });

  it("reports peak, average, charging time and the maximum current", () => {
    const s = summarize([sample(0, 3), sample(1, 7), sample(2, 7), sample(3, 0)], 10_000, 10_100, T0, T0 + 120);
    expect(s.status).toBe("completed");
    expect(s.peak_power_kw).toBe(7);
    expect(s.avg_power_kw).toBe(3); // 0.1 kWh over 120 s is 3 kW
    expect(s.charging_seconds).toBe(90);
    expect(s.max_current_a).toBe(30);
  });

  it("scales the energy from each source so the three add up to the meter's energy", () => {
    // 1 hour at 4 kW: the meter says 4 kWh; the samples say 1 kW solar + 3 kW grid the whole time
    const samples = Array.from({ length: 120 }, (_, i) => sample(i, 4, [1000, 0, 3000]));
    const s = summarize(samples, 0, 4000, T0, T0 + 3600);
    expect(s.energy_from_solar_kwh).toBeCloseTo(1, 2);
    expect(s.energy_from_grid_kwh).toBeCloseTo(3, 2);
    expect(s.energy_from_battery_kwh).toBe(0);
    expect(s.solar_share_pct).toBeCloseTo(25, 1);
    expect(s.site_data_coverage_pct).toBe(100);
    expect(s.energy_unattributed_kwh).toBeCloseTo(0, 2);
  });

  it("puts the part of a session with no site data into 'unattributed', and says how much was covered", () => {
    const samples = [...Array.from({ length: 60 }, (_, i) => sample(i, 4, [4000, 0, 0])), ...Array.from({ length: 60 }, (_, i) => sample(60 + i, 4))];
    const s = summarize(samples, 0, 4000, T0, T0 + 3600);
    expect(s.site_data_coverage_pct).toBe(50);
    expect(s.energy_from_solar_kwh).toBeCloseTo(2, 2);
    expect(s.energy_unattributed_kwh).toBeCloseTo(2, 2);
  });

  it("with no site data at all, all of it is unattributed", () => {
    const s = summarize([sample(0, 3), sample(1, 3)], 0, 1500, T0, T0 + 60);
    expect(s.energy_unattributed_kwh).toBe(1.5);
    expect(s.energy_from_solar_kwh).toBeNull();
  });

  it("marks a meter that went backwards, or an impossible rate, as suspect, and keeps the figures as reported", () => {
    expect(summarize([], 5000, 4000, T0, T0 + 600)).toMatchObject({ status: "suspect", suspect_reason: "the meter went backwards" });
    expect(summarize([], 0, 5_000_000, T0, T0 + 60)).toMatchObject({ status: "suspect" });
  });

  it("copes with no samples and a zero-length session", () => {
    const s = summarize([], 100, 100, T0, T0);
    expect(s).toMatchObject({ status: "completed", peak_power_kw: null, charging_seconds: 0, avg_power_kw: null });
  });
});
