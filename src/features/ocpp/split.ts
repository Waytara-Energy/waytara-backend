/**
 * Where the energy of a charging session came from (plan 13.5, decisions S19 and S24: the charger is on the inverter's load output, and the
 * car draws solar first, then the battery, then the grid). Pure functions; the numbers are an ESTIMATE from measured power balances and
 * the pages say so.
 */

export interface SiteFigures {
  /** solar power, W */
  pv_w: number | null;
  /** above zero = the battery is discharging */
  battery_w: number | null;
  /** above zero = importing from the grid */
  grid_w: number | null;
  /** the house load including the charger, W */
  load_w: number | null;
}

export interface Split {
  ev_from_solar_w: number;
  ev_from_battery_w: number;
  ev_from_grid_w: number;
}

const pos = (n: number | null) => (n !== null && Number.isFinite(n) ? Math.max(0, n) : 0);

/**
 * The car's power `evW` (watts) split among the three sources at one moment. The house pools come first: what the battery gives, what the
 * grid gives, and what is left (solar, never more than the solar being produced). Returns null when the site figures are not enough
 * to say anything (no load, or nothing known), so nothing is invented.
 */
export function splitSample(evW: number, site: SiteFigures | null): Split | null {
  if (!site || evW <= 0 || site.load_w === null || !Number.isFinite(site.load_w) || site.load_w <= 0) return null;
  if (site.pv_w === null && site.battery_w === null && site.grid_w === null) return null;
  const load = site.load_w;
  const batteryPool = Math.min(pos(site.battery_w), load);
  const gridPool = Math.min(pos(site.grid_w), Math.max(0, load - batteryPool));
  let solarPool = Math.max(0, load - batteryPool - gridPool);
  if (site.pv_w !== null) solarPool = Math.min(solarPool, pos(site.pv_w)); // never more solar than is being made

  const evSolar = Math.min(evW, solarPool);
  const evBattery = Math.min(evW - evSolar, batteryPool);
  const evGrid = evW - evSolar - evBattery;
  return { ev_from_solar_w: Math.round(evSolar), ev_from_battery_w: Math.round(evBattery), ev_from_grid_w: Math.round(evGrid) };
}

export interface StoredSample {
  /** seconds since 1970 */
  ts: number;
  power_kw: number | null;
  current_a: number | null;
  has_site: boolean;
  solar_w: number | null;
  battery_w: number | null;
  grid_w: number | null;
  /** the charger's own energy reading at that moment, if it reported one */
  energy_kwh?: number | null;
}

export interface SessionSummary {
  status: "completed" | "suspect" | "aborted";
  peak_power_kw: number | null;
  avg_power_kw: number | null;
  max_current_a: number | null;
  charging_seconds: number;
  energy_from_solar_kwh: number | null;
  energy_from_battery_kwh: number | null;
  energy_from_grid_kwh: number | null;
  energy_unattributed_kwh: number | null;
  solar_share_pct: number | null;
  site_data_coverage_pct: number | null;
  /** why a session was marked suspect, for the event log */
  suspect_reason?: string;
}

const CHARGING_KW = 0.1;
const MAX_PLAUSIBLE_KW = 350; // above any charger we sell; a session faster than this on average is not believed

/**
 * The figures of a finished session. Each sample's power is taken to hold until the next sample (the last one until the end of the session
 * at most 60 s), the energy from each source is that sum scaled so the three add up to the meter's energy, and a session with an
 * impossible energy is marked "suspect" (kept as reported, never corrected).
 */
export function summarize(samples: readonly StoredSample[], meterStartWh: number, meterStopWh: number, startedAtS: number, endedAtS: number): SessionSummary {
  const energyKwh = (meterStopWh - meterStartWh) / 1000;
  const durationS = Math.max(0, endedAtS - startedAtS);
  let suspect: string | undefined;
  if (energyKwh < 0) suspect = "the meter went backwards";
  else if (durationS > 0 && (energyKwh * 3600) / durationS > MAX_PLAUSIBLE_KW) suspect = "more energy than the charger can deliver in that time";

  const s = [...samples].sort((a, b) => a.ts - b.ts);
  let peak: number | null = null;
  let maxA: number | null = null;
  let charging = 0;
  let sumKwSeconds = 0;
  let covered = 0;
  let solarWs = 0;
  let batteryWs = 0;
  let gridWs = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = s[i]!;
    const until = i + 1 < s.length ? s[i + 1]!.ts : Math.min(endedAtS, cur.ts + 60);
    const dt = Math.max(0, until - cur.ts);
    if (cur.power_kw !== null) {
      peak = peak === null ? cur.power_kw : Math.max(peak, cur.power_kw);
      sumKwSeconds += cur.power_kw * dt;
      if (cur.power_kw > CHARGING_KW) charging += dt;
    }
    if (cur.current_a !== null) maxA = maxA === null ? cur.current_a : Math.max(maxA, cur.current_a);
    if (cur.has_site && cur.power_kw !== null && cur.power_kw > CHARGING_KW) {
      covered += dt;
      solarWs += (cur.solar_w ?? 0) * dt;
      batteryWs += (cur.battery_w ?? 0) * dt;
      gridWs += (cur.grid_w ?? 0) * dt;
    }
  }

  const out: SessionSummary = {
    status: suspect ? "suspect" : "completed",
    peak_power_kw: peak,
    avg_power_kw: durationS > 0 && energyKwh >= 0 ? Math.round((energyKwh * 3600 * 100) / durationS) / 100 : charging > 0 ? Math.round((sumKwSeconds / charging) * 100) / 100 : null,
    max_current_a: maxA,
    charging_seconds: Math.round(charging),
    energy_from_solar_kwh: null,
    energy_from_battery_kwh: null,
    energy_from_grid_kwh: null,
    energy_unattributed_kwh: null,
    solar_share_pct: null,
    site_data_coverage_pct: charging > 0 ? Math.round((covered / charging) * 1000) / 10 : null,
  };
  if (suspect) out.suspect_reason = suspect;

  const attributed = (solarWs + batteryWs + gridWs) / 3_600_000; // W s -> kWh
  if (attributed > 0 && energyKwh > 0) {
    // the three add up to what the meter says, whatever the sampling missed; the part with no site data is reported as unattributed
    const coveredShare = charging > 0 ? Math.min(1, covered / charging) : 1;
    const scale = (energyKwh * coveredShare) / attributed;
    const r = (kwh: number) => Math.round(kwh * 1000) / 1000;
    out.energy_from_solar_kwh = r((solarWs / 3_600_000) * scale);
    out.energy_from_battery_kwh = r((batteryWs / 3_600_000) * scale);
    out.energy_from_grid_kwh = r((gridWs / 3_600_000) * scale);
    out.energy_unattributed_kwh = r(Math.max(0, energyKwh - out.energy_from_solar_kwh - out.energy_from_battery_kwh - out.energy_from_grid_kwh));
    const total = out.energy_from_solar_kwh + out.energy_from_battery_kwh + out.energy_from_grid_kwh;
    out.solar_share_pct = total > 0 ? Math.round((out.energy_from_solar_kwh / total) * 1000) / 10 : null;
  } else if (energyKwh > 0) {
    out.energy_unattributed_kwh = Math.round(energyKwh * 1000) / 1000;
  }
  return out;
}
