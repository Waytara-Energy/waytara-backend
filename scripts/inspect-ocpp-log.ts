/**
 * Looks at the long-term charger message log in the file store: how many files and messages per charger and day, and (with a charger id
 * and a day) prints the messages.   npm run inspect:ocpp-log -- [equipment id] [yyyy-mm-dd]
 * Reads the R2 settings from .env.render (npm run does that); never prints keys. Card identifiers are already hidden in the files.
 */
import { gunzipSync } from "node:zlib";
import { loadConfig } from "../src/config.js";
import { R2ObjectStore } from "../src/storage/object-store.js";

const config = loadConfig({ ...process.env, NODE_ENV: "development" });
if (!config.r2) {
  process.stderr.write("the R2 settings are not set\n");
  process.exit(1);
}
const store = new R2ObjectStore(config.r2);
const [equipment, day] = process.argv.slice(2);

if (equipment && day) {
  const files = await store.list(`ocpp/v1/${equipment}/${day.replace(/-/g, "/")}/`);
  for (const f of files.sort((a, b) => a.key.localeCompare(b.key))) {
    const body = await store.get(f.key);
    if (body) process.stdout.write(gunzipSync(body).toString("utf8"));
  }
} else {
  const files = await store.list("ocpp/v1/");
  const perDay = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const k = f.key.split("/").slice(2, 6).join("/");
    const e = perDay.get(k) ?? { files: 0, bytes: 0 };
    e.files++;
    e.bytes += f.size;
    perDay.set(k, e);
  }
  for (const [k, v] of [...perDay].sort()) process.stdout.write(`${k}  ${v.files} files  ${v.bytes} bytes\n`);
  if (perDay.size === 0) process.stdout.write("no message logs yet\n");
}
