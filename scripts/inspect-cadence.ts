/**
 * Shows what the file store holds for one equipment: the files of the last N minutes (default 30) and what is in them. For checking a
 * live run by eye; the reports themselves are served by GET /v1/reports/cadence.
 *   npx tsx --env-file=.env.render scripts/inspect-cadence.ts <equipment id> [minutes]
 */
import { loadConfig } from "../src/config.js";
import { dayFolder, dayStartOf } from "../src/core/cadence-part.js";
import { CadenceArchive } from "../src/features/cadence/archive.js";
import { R2ObjectStore } from "../src/storage/object-store.js";

const id = process.argv[2];
const minutes = Number(process.argv[3] ?? 30);
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
  process.stderr.write("usage: inspect-cadence.ts <equipment id> [minutes]\n");
  process.exit(1);
}
const config = loadConfig({ ...process.env, NODE_ENV: "development" });
if (!config.r2) {
  process.stderr.write("the R2 settings are not all set\n");
  process.exit(1);
}
const store = new R2ObjectStore(config.r2);
const log = { info: () => undefined, warn: () => undefined };
const say = (s: string) => process.stdout.write(s + "\n");

const now = Date.now();
const from = now - minutes * 60_000;
const files = (await store.list(dayFolder(id, dayStartOf(from)))).concat(dayStartOf(now) !== dayStartOf(from) ? await store.list(dayFolder(id, dayStartOf(now))) : []);
say(`files today: ${files.length}${files.length ? ` (newest ${new Date(Math.max(...files.map((f) => f.modified))).toISOString()})` : ""}`);
const rows = await new CadenceArchive(store, log).read(id, from, now);
say(`frames in the last ${minutes} minutes: ${rows.length}`);
if (rows.length > 0) {
  const first = rows[0]!;
  const last = rows.at(-1)!;
  say(`first: ${new Date(first.t).toISOString()} boot ${first.boot} seq ${first.seq}, ${first.words.size} registers`);
  say(`last:  ${new Date(last.t).toISOString()} boot ${last.boot} seq ${last.seq}, ${last.words.size} registers`);
  const seqs = new Set(rows.filter((r) => r.boot === last.boot).map((r) => r.seq));
  const gaps = [...seqs].filter((s) => s > Math.min(...seqs) && !seqs.has(s - 1)).length;
  say(`gaps in the frame numbers of boot ${last.boot}: ${gaps}`);
  say(`words of the last frame (first 12): ${[...last.words].slice(0, 12).map(([r, w]) => `${r}=${w}`).join(" ")}`);
}
