import { describe, expect, it } from "vitest";
import type { CadenceRow } from "../src/core/cadence-part.js";
import { availableColumns, csvHeader, csvLines, decodeRows, istTimestamp, pickColumns } from "../src/features/cadence/report.js";
import type { EquipmentProfile } from "../src/features/ingest/store.js";
import { defOf } from "./fake-store.js";

const T = Date.UTC(2026, 9, 14, 18, 30, 5); // 2026-10-15 00:00:05 IST
const row = (t: number, words: Record<number, number>): CadenceRow => ({ t, boot: 1, seq: t, words: new Map(Object.entries(words).map(([k, v]) => [Number(k), v])) });

const profile = (): EquipmentProfile => ({
  equipmentId: "e",
  uploadIntervalS: 900,
  metrics: [
    defOf("pv1_power_w"),
    defOf("battery_power_w"),
    defOf("day_pv_energy_kwh"),
    { ...defOf("battery_soc_pct"), showForUser: false },
    { ...defOf("battery_soc_pct"), key: "internal_x", registers: [900], decode: null, showForUser: false },
    { ...defOf("pv1_power_w"), key: "set_point", direction: "write" },
    { ...defOf("pv1_power_w"), key: "no_register", registers: [] },
  ],
  labels: {
    pv1_power_w: { label: "PV1 power", unit: "W", category: "Solar" },
    battery_power_w: { label: "Battery power", unit: "W", category: "Battery" },
    day_pv_energy_kwh: { label: "Solar today", unit: "kWh", category: "Energy" },
    battery_soc_pct: { label: "Battery charge", unit: "%", category: "Battery" },
    internal_x: { label: "Internal x", unit: null, category: null },
  },
});

describe("what a person may pick", () => {
  it("gives staff every reading with registers, and nothing that is only written or has no register", () => {
    expect(availableColumns(profile(), "staff").map((c) => c.key).sort()).toEqual(["battery_power_w", "battery_soc_pct", "day_pv_energy_kwh", "internal_x", "pv1_power_w"]);
  });

  it("gives a customer only what the customer view shows", () => {
    expect(availableColumns(profile(), "customer").map((c) => c.key).sort()).toEqual(["battery_power_w", "day_pv_energy_kwh", "pv1_power_w"]);
  });

  it("groups by category then name, and falls back to the key when there is no name", () => {
    const cols = availableColumns(profile(), "staff");
    expect(cols.map((c) => c.label)).toEqual(["Internal x", "Battery charge", "Battery power", "Solar today", "PV1 power"]);
    expect(cols[0]!.category).toBeNull();
    const bare = availableColumns({ ...profile(), labels: undefined }, "staff").find((c) => c.key === "pv1_power_w")!;
    expect(bare.label).toBe("pv1_power_w");
    expect(bare.unit).toBeNull();
  });

  it("lists a key once even when the catalogue repeats it", () => {
    const p = profile();
    p.metrics.push(defOf("pv1_power_w"));
    expect(availableColumns(p, "staff").filter((c) => c.key === "pv1_power_w")).toHaveLength(1);
  });

  it("refuses unavailable keys without saying whether they exist or are hidden", () => {
    const customer = availableColumns(profile(), "customer");
    expect(pickColumns(customer, ["pv1_power_w", "internal_x", "nonsense"])).toEqual({ ok: false, unknown: ["internal_x", "nonsense"] });
    const ok = pickColumns(customer, ["day_pv_energy_kwh", "pv1_power_w", "day_pv_energy_kwh"]);
    expect(ok.ok && ok.columns.map((c) => c.key)).toEqual(["day_pv_energy_kwh", "pv1_power_w"]);
  });
});

describe("decoding rows", () => {
  const cols = () => {
    const picked = pickColumns(availableColumns(profile(), "staff"), ["pv1_power_w", "battery_power_w", "day_pv_energy_kwh"]);
    if (!picked.ok) throw new Error("no");
    return picked.columns;
  };

  it("applies the catalogue to the raw words: scale, and signed numbers", () => {
    const rows = decodeRows([row(T, { 186: 120, 190: 65476, 108: 123 })], cols());
    expect(rows).toEqual([{ t: T, cells: [120, -60, 12.3] }]);
  });

  it("leaves a value empty when the frame did not carry its register, and drops frames with none of the picked values", () => {
    const rows = decodeRows([row(T, { 186: 120 }), row(T + 5000, { 184: 80 }), row(T + 10_000, { 190: 5, 186: 0 })], cols());
    expect(rows).toEqual([
      { t: T, cells: [120, null, null] },
      { t: T + 10_000, cells: [0, 5, null] },
    ]);
  });

  it("decodes again from raw words when the catalogue changes, which is why words are what is stored", () => {
    const p = profile();
    const fixed = { ...p, metrics: p.metrics.map((m) => (m.key === "day_pv_energy_kwh" ? { ...m, decode: { scale: 0.01 } } : m)) };
    const picked = pickColumns(availableColumns(fixed, "staff"), ["day_pv_energy_kwh"]);
    if (!picked.ok) throw new Error("no");
    expect(decodeRows([row(T, { 108: 123 })], picked.columns)[0]!.cells).toEqual([1.23]);
  });
});

describe("the CSV", () => {
  it("shows India time and titles with units", () => {
    expect(istTimestamp(T)).toBe("2026-10-15 00:00:05");
    const cols = availableColumns(profile(), "customer");
    expect(csvHeader(cols).trimEnd()).toBe("Time (IST),Battery power (W),Solar today (kWh),PV1 power (W)");
  });

  it("leaves a missing value empty and writes numbers as they are", () => {
    expect(csvLines([{ t: T, cells: [120, null, -0.5] }])).toBe("2026-10-15 00:00:05,120,,-0.5\r\n");
  });

  it("quotes titles and text that need it, and defuses text a spreadsheet would run as a formula", () => {
    expect(csvHeader([{ label: 'Power, "total"', unit: "W" }])).toBe('Time (IST),"Power, ""total"" (W)"\r\n');
    expect(csvLines([{ t: T, cells: ["=HYPERLINK(\"x\")", "+1", "plain", "a,b"] }])).toBe("2026-10-15 00:00:05,\"'=HYPERLINK(\"\"x\"\")\",'+1,plain,\"a,b\"\r\n");
  });
});
