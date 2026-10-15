import type { SampledValue } from "./schemas.js";

/**
 * Turns the sampled values of one MeterValues entry into one row of the figures we store (plan 13.5). A value carries its unit in the
 * message, and the unit decides the conversion, never an assumption: the Plugzmart charger sends the energy register in kWh and the
 * power in kW, while the OCPP default (when no unit is given) is Wh and W. What the charger did not report stays absent, never zero.
 */

export interface Sample {
  energy_kwh?: number;
  power_kw?: number;
  current_a_l1?: number;
  current_a_l2?: number;
  current_a_l3?: number;
  voltage_v_l1?: number;
  voltage_v_l2?: number;
  voltage_v_l3?: number;
  current_offered_a?: number;
  soc_pct?: number;
  temperature_c?: number;
  frequency_hz?: number;
  power_factor?: number;
}

const num = (s: string): number | null => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
};
const unitOf = (v: SampledValue, fallback: string): string => (v.unit ?? fallback).toLowerCase();

/** "L1", "L1-N" and "L1-L2" style phases to 1, 2 or 3; a value with no phase belongs to the single phase (1). */
function phaseOf(v: SampledValue): 1 | 2 | 3 | 0 {
  const p = (v.phase ?? "").toUpperCase();
  if (p === "") return 0;
  if (p.startsWith("L1")) return 1;
  if (p.startsWith("L2")) return 2;
  if (p.startsWith("L3")) return 3;
  return 0; // "N" and unknown phases are not stored per phase
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function normalizeSample(values: readonly SampledValue[]): Sample {
  const out: Sample = {};
  const power = { total: undefined as number | undefined, phases: [] as number[] };
  const current: Partial<Record<1 | 2 | 3, number>> = {};
  const voltage: Partial<Record<1 | 2 | 3, number>> = {};

  for (const v of values) {
    const n = num(v.value);
    if (n === null) continue;
    const m = v.measurand ?? "Energy.Active.Import.Register"; // the OCPP default measurand
    const ph = phaseOf(v);
    switch (m) {
      case "Energy.Active.Import.Register": {
        const u = unitOf(v, "wh");
        const kwh = u === "kwh" ? n : u === "wh" ? n / 1000 : null;
        if (kwh !== null && kwh >= 0) out.energy_kwh = round(kwh, 4);
        break;
      }
      case "Power.Active.Import": {
        const u = unitOf(v, "w");
        const kw = u === "kw" ? n : u === "w" ? n / 1000 : null;
        if (kw === null) break;
        if (ph === 0) power.total = kw;
        else power.phases.push(kw);
        break;
      }
      case "Current.Import":
        current[ph === 0 ? 1 : ph] = Math.max(current[ph === 0 ? 1 : ph] ?? -Infinity, n);
        break;
      case "Voltage":
        // a phase-to-phase voltage ("L1-L2") is not the phase voltage: only L1/L2/L3 to neutral, or no phase at all
        if (!/^L[123]-L[123]$/i.test(v.phase ?? "")) voltage[ph === 0 ? 1 : ph] = n;
        break;
      case "Current.Offered":
        out.current_offered_a = n;
        break;
      case "SoC":
        if (n >= 0 && n <= 100) out.soc_pct = n;
        break;
      case "Temperature": {
        const u = unitOf(v, "celsius");
        out.temperature_c = u === "fahrenheit" ? round(((n - 32) * 5) / 9, 2) : u === "k" ? round(n - 273.15, 2) : n;
        break;
      }
      case "Frequency":
        out.frequency_hz = n;
        break;
      case "Power.Factor":
        out.power_factor = n;
        break;
      default:
        break; // other measurands stay in the raw copy only
    }
  }

  if (power.total !== undefined) out.power_kw = round(power.total, 4);
  else if (power.phases.length > 0) out.power_kw = round(power.phases.reduce((a, b) => a + b, 0), 4);
  if (current[1] !== undefined) out.current_a_l1 = current[1];
  if (current[2] !== undefined) out.current_a_l2 = current[2];
  if (current[3] !== undefined) out.current_a_l3 = current[3];
  if (voltage[1] !== undefined) out.voltage_v_l1 = voltage[1];
  if (voltage[2] !== undefined) out.voltage_v_l2 = voltage[2];
  if (voltage[3] !== undefined) out.voltage_v_l3 = voltage[3];
  return out;
}
