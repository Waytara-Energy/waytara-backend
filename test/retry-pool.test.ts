import { describe, expect, it } from "vitest";
import { RetryPool } from "../src/features/ocpp/retry-pool.js";

const log = { info: () => undefined, warn: () => undefined };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the retry pool", () => {
  it("tries again until the work succeeds, then forgets it", async () => {
    const pool = new RetryPool({ log, delaysMs: [10] });
    let tries = 0;
    pool.add("k", 1, async () => {
      if (++tries < 3) throw new Error("down");
    });
    expect(pool.pending()).toBe(1);
    await wait(150);
    expect(tries).toBe(3);
    expect(pool.pending()).toBe(0);
    pool.stop();
  });

  it("lets a higher priority replace a lower one, and drops a lower one while a higher one waits", async () => {
    const pool = new RetryPool({ log, delaysMs: [20] });
    const ran: string[] = [];
    pool.add("k", 1, async () => void ran.push("low"));
    pool.add("k", 2, async () => void ran.push("high"));
    pool.add("k", 1, async () => void ran.push("low again"));
    await wait(100);
    expect(ran).toEqual(["high"]);
    pool.stop();
  });

  it("forgets a job that was cancelled, and gives up after the time allowed", async () => {
    let t = 0;
    const warned: string[] = [];
    const pool = new RetryPool({ log: { info: () => undefined, warn: (_o, m) => void warned.push(m) }, delaysMs: [10], giveUpMs: 1000, now: () => t });
    let cancelledRan = false;
    pool.add("a", 1, async () => void (cancelledRan = true));
    pool.cancel("a");
    pool.add("b", 1, async () => {
      t += 2000;
      throw new Error("down");
    });
    await wait(100);
    expect(cancelledRan).toBe(false);
    expect(pool.has("b")).toBe(false);
    expect(warned).toContain("gave up retrying database work");
    pool.stop();
  });
});
