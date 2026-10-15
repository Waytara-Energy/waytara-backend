/**
 * Checks the file-store settings (Cloudflare R2) the way the backend will use them: reach the bucket, write a file, read it back,
 * list it, delete it. Prints OK or FAIL per step and never the keys.
 *   npm run check:r2            reads R2_* from .env
 *   npm run check:render-r2     reads them from .env.render
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { R2ObjectStore } from "../src/storage/object-store.js";

const out = (ok: boolean, text: string) => process.stdout.write(`${ok ? "OK  " : "FAIL"} ${text}\n`);

const config = loadConfig({ ...process.env, NODE_ENV: "development" });
if (!config.r2) {
  out(false, "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are not all set");
  process.exit(1);
}
const store = new R2ObjectStore(config.r2);
const key = `_check/${randomUUID()}.txt`;
let failed = false;
const step = async (text: string, fn: () => Promise<boolean | void>) => {
  try {
    const r = await fn();
    out(r !== false, text);
    if (r === false) failed = true;
  } catch (error) {
    failed = true;
    out(false, `${text}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

await step(`bucket "${config.r2.bucket}" is reachable with these keys`, () => store.ping());
await step("a file can be written", () => store.put(key, Buffer.from("waytara check"), "text/plain"));
await step("and read back", async () => (await store.get(key))?.toString("utf8") === "waytara check");
await step("and found in a listing", async () => (await store.list("_check/")).some((f) => f.key === key));
await step("and deleted", async () => {
  await store.delete(key);
  return (await store.get(key)) === null;
});
process.exit(failed ? 1 : 0);
