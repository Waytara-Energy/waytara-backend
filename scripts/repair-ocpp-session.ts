/**
 * Closes a charging session from the charger's own stop report when that report never reached the database (it was unreachable when the charger
 * sent it, and the charger gave up resending). The report is in the long-term message log: look it up with `npm run inspect:ocpp-log` and pass
 * what it says. The figures are worked out exactly as for a live stop (the same summary of the stored readings).
 *
 *   npm run repair:ocpp-session -- --equipment <uuid> --transaction <n> --meter-stop <Wh> --ended-at <ISO time> [--reason Remote]
 *
 * Without --apply it only prints what it would write. It prints no key or password.
 */
import { ConfigError, loadConfig } from "../src/config.js";
import { createSupabaseGatewayDb } from "../src/db/supabase-gateway-db.js";
import { SupabaseEvStore } from "../src/db/supabase-ev-store.js";
import { summarize } from "../src/features/ocpp/split.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const equipment = arg("equipment");
  const transaction = Number(arg("transaction"));
  const meterStop = Number(arg("meter-stop"));
  const endedAt = arg("ended-at");
  const reason = arg("reason") ?? "Remote";
  const apply = process.argv.includes("--apply");
  if (!equipment || !Number.isInteger(transaction) || !Number.isFinite(meterStop) || !endedAt || Number.isNaN(Date.parse(endedAt))) {
    out("FAIL usage: --equipment <uuid> --transaction <n> --meter-stop <Wh> --ended-at <ISO time> [--reason Remote] [--apply]");
    return 1;
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    out(error instanceof ConfigError ? `FAIL settings\n${error.message}` : "FAIL settings could not be read");
    return 1;
  }
  if (!config.supabase) {
    out("FAIL the database settings are not set");
    return 1;
  }
  const store = new SupabaseEvStore(createSupabaseGatewayDb(config.supabase));
  const ref = await store.sessionByTransaction(equipment, transaction);
  if (!ref) {
    out(`FAIL no session with transaction ${transaction} for that charger`);
    return 1;
  }
  const samples = await store.sessionSamples(ref.id);
  const meterStart = ref.meterStartWh ?? meterStop;
  const endedIso = new Date(endedAt).toISOString();
  const summary = summarize(samples, meterStart, meterStop, Date.parse(ref.startedAt) / 1000, Date.parse(endedIso) / 1000);
  out(`session ${ref.id}: status now "${ref.status}", started ${ref.startedAt}, meter start ${meterStart} Wh, ${samples.length} stored readings`);
  out(`would write: ended ${endedIso}, meter stop ${meterStop} Wh (${((meterStop - meterStart) / 1000).toFixed(3)} kWh), reason ${reason}`);
  out(JSON.stringify(summary));
  if (!apply) {
    out("dry run: nothing was written (add --apply to write it)");
    return 0;
  }
  await store.sessionStop(ref.id, endedIso, meterStop, reason, summary);
  const after = await store.sessionByTransaction(equipment, transaction);
  out(`written: status now "${after?.status ?? "unknown"}", ended ${after?.endedAt ?? "?"}`);
  return 0;
}

process.exitCode = await main();
