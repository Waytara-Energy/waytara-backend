/**
 * Read-only soak report: how steadily the office board has been sending readings since a start time (frames per hour and the longest gaps).
 * Pass = no gap over 2 minutes except planned ones, about one reading per 5 seconds, and the hub not restarting unexpectedly.
 *   node --env-file=.env.render node_modules/tsx/dist/cli.mjs scripts/soak-report.ts "2026-10-21T17:37:00+05:30"
 * (.env.render holds the R2 settings; it is not committed.)
 */
import { loadConfig } from "../src/config.js";
import { CadenceArchive } from "../src/features/cadence/archive.js";
import { R2ObjectStore } from "../src/storage/object-store.js";

const id = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const startIst = process.argv[2] ?? "2026-10-21T11:00:00+05:30";
const from = Date.parse(startIst);
const now = Date.now();
const config = loadConfig({ ...process.env, NODE_ENV: "development" });
if (!config.r2) throw new Error("the R2 settings are not set");
const archive = new CadenceArchive(new R2ObjectStore(config.r2), { info: () => undefined, warn: () => undefined });

// the archive is read in 12-hour pieces
const times: number[] = [];
for (let a = from; a < now; a += 12 * 3600_000) {
  const rows = await archive.read(id, a, Math.min(a + 12 * 3600_000, now));
  for (const r of rows) times.push(r.t);
}
times.sort((x, y) => x - y);
const say = (s: string) => process.stdout.write(s + "\n");
const ist = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
say(`since ${ist(from)} IST: ${times.length} readings, ${((now - from) / 3600_000).toFixed(1)} h elapsed`);
if (times.length === 0) process.exit(0);

const gaps: { from: number; to: number }[] = [];
for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! > 120_000) gaps.push({ from: times[i - 1]!, to: times[i]! });
gaps.sort((a, b) => b.to - b.from - (a.to - a.from));
say(`first reading ${ist(times[0]!)}, last reading ${ist(times[times.length - 1]!)} (${Math.round((now - times[times.length - 1]!) / 1000)} s ago)`);
say(`gaps longer than 2 minutes: ${gaps.length}`);
for (const g of gaps.slice(0, 8)) say(`  ${ist(g.from)} -> ${ist(g.to)}  (${Math.round((g.to - g.from) / 60_000)} min)`);

const perHour = new Map<string, number>();
for (const t of times) {
  const k = new Date(t).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit" });
  perHour.set(k, (perHour.get(k) ?? 0) + 1);
}
say("readings per hour (IST):");
for (const [k, n] of perHour) say(`  ${k}h  ${n}`);
