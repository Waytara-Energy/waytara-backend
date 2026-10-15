import type { CadenceArchive } from "./archive.js";
import type { Logger } from "./writer.js";

/**
 * Joins each finished day's 5-minute files into one day file. It runs shortly after start-up (looking back over the whole four weeks,
 * so a service that slept or was redeployed catches up) and then every hour over the last three days (frames a board held back can
 * still land in yesterday's files). Not tied to a clock time, so a Render service that sleeps at 02:00 loses nothing.
 */
const FIRST_RUN_AFTER_MS = 60_000;
const EVERY_MS = 3_600_000;

export function startCadenceMaintenance(archive: Pick<CadenceArchive, "mergeFinishedDays">, log: Logger): { stop(): void } {
  let stopped = false;
  let first = true;
  let timer: NodeJS.Timeout | undefined;

  const run = async () => {
    try {
      const r = await archive.mergeFinishedDays(first ? 28 : 3);
      if (r.merged > 0 || r.failed > 0) log.info({ merged: r.merged, failed: r.failed }, "cadence day files joined");
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, "joining cadence day files failed");
    }
    first = false;
    if (!stopped) schedule(EVERY_MS);
  };
  const schedule = (ms: number) => {
    timer = setTimeout(() => void run(), ms);
    timer.unref();
  };
  schedule(FIRST_RUN_AFTER_MS);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
