import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCadenceMaintenance } from "../src/features/cadence/maintenance.js";
import { MemoryObjectStore, R2ObjectStore, StoreError } from "../src/storage/object-store.js";
import { loadConfig, ConfigError } from "../src/config.js";
import { testApp } from "./helpers.js";

/** A stand-in for the S3 client: records the commands and answers from a script. */
function fakeClient(answer: (name: string, input: Record<string, unknown>) => unknown) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  return {
    sent,
    client: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        const r = answer(command.constructor.name, command.input);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}
const named = (name: string, status?: number) => Object.assign(new Error("x"), { name, $metadata: { httpStatusCode: status } });
const settings = { accountId: "0".repeat(32), accessKeyId: "AKIA-TEST-KEY-0123456789", secretAccessKey: "s".repeat(40), bucket: "waytara-cadence" };
const body = (b: Buffer) => ({ transformToByteArray: async () => new Uint8Array(b) });

describe("R2ObjectStore", () => {
  it("writes a file with its type and reads it back", async () => {
    const { client, sent } = fakeClient((n) => (n === "GetObjectCommand" ? { Body: body(Buffer.from("abc")) } : {}));
    const s = new R2ObjectStore(settings, client as never);
    await s.put("cadence/v1/x/1.csv.gz", Buffer.from("abc"), "application/gzip");
    expect(await s.get("cadence/v1/x/1.csv.gz")).toEqual(Buffer.from("abc"));
    expect(sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "waytara-cadence", Key: "cadence/v1/x/1.csv.gz", ContentType: "application/gzip" } });
  });

  it("answers null for a missing file, and an error for any other problem, without leaking details", async () => {
    const missing = new R2ObjectStore(settings, fakeClient(() => named("NoSuchKey", 404)).client as never);
    expect(await missing.get("k")).toBeNull();
    const denied = new R2ObjectStore(settings, fakeClient(() => named("AccessDenied", 403)).client as never);
    await expect(denied.get("k")).rejects.toThrow(StoreError);
    await expect(denied.put("k", Buffer.from("x"))).rejects.toThrow(/could not save a file \(AccessDenied\)/);
    await expect(denied.ping()).rejects.toThrow(/reach the bucket/);
  });

  it("lists every page, with sizes and times", async () => {
    let page = 0;
    const { client, sent } = fakeClient(() =>
      page++ === 0
        ? { Contents: [{ Key: "a/1", Size: 5, LastModified: new Date(1000) }], IsTruncated: true, NextContinuationToken: "t1" }
        : { Contents: [{ Key: "a/2", Size: 7, LastModified: new Date(2000) }], IsTruncated: false },
    );
    expect(await new R2ObjectStore(settings, client as never).list("a/")).toEqual([
      { key: "a/1", size: 5, modified: 1000 },
      { key: "a/2", size: 7, modified: 2000 },
    ]);
    expect(sent[1]!.input.ContinuationToken).toBe("t1");
  });

  it("lists folders one level down", async () => {
    const { client, sent } = fakeClient(() => ({ CommonPrefixes: [{ Prefix: "cadence/v1/a/" }, { Prefix: "cadence/v1/b/" }] }));
    expect(await new R2ObjectStore(settings, client as never).listFolders("cadence/v1/")).toEqual(["cadence/v1/a/", "cadence/v1/b/"]);
    expect(sent[0]!.input.Delimiter).toBe("/");
  });
});

describe("MemoryObjectStore", () => {
  it("behaves like the real thing for the parts the backend uses", async () => {
    const s = new MemoryObjectStore(() => 5);
    await s.put("cadence/v1/a/2026/10/15/0805.csv.gz", Buffer.from("1"));
    await s.put("cadence/v1/b/2026/10/15/0805.csv.gz", Buffer.from("22"));
    expect(await s.listFolders("cadence/v1/")).toEqual(["cadence/v1/a/", "cadence/v1/b/"]);
    expect(await s.list("cadence/v1/a/")).toEqual([{ key: "cadence/v1/a/2026/10/15/0805.csv.gz", size: 1, modified: 5 }]);
    expect(await s.get("nope")).toBeNull();
    await s.delete("cadence/v1/a/2026/10/15/0805.csv.gz");
    expect(await s.list("cadence/v1/a/")).toEqual([]);
  });
});

describe("the daily join job", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs a minute after start over the whole four weeks, then hourly over three days, and stops when asked", async () => {
    const calls: number[] = [];
    const archive = { mergeFinishedDays: async (n: number) => (calls.push(n), { merged: 1, failed: 0 }) };
    const log = { info: vi.fn(), warn: vi.fn() };
    const job = startCadenceMaintenance(archive, log);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual([28]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(calls).toEqual([28, 3]);
    expect(log.info).toHaveBeenCalledWith({ merged: 1, failed: 0 }, "cadence day files joined");
    job.stop();
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(calls).toEqual([28, 3]);
  });

  it("keeps going after a failure and says so", async () => {
    let n = 0;
    const archive = {
      mergeFinishedDays: async () => {
        if (n++ === 0) throw new Error("boom");
        return { merged: 0, failed: 0 };
      },
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    const job = startCadenceMaintenance(archive, log);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(log.warn).toHaveBeenCalledWith({ err: "boom" }, "joining cadence day files failed");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(n).toBe(2);
    job.stop();
  });
});

describe("settings for the file store", () => {
  const good = { R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "k".repeat(20), R2_SECRET_ACCESS_KEY: "s".repeat(40), R2_BUCKET: "waytara-cadence" };

  it("are optional, and give the store when all four are set", () => {
    expect(loadConfig({}).r2).toBeUndefined();
    expect(loadConfig(good).r2).toEqual({ accountId: good.R2_ACCOUNT_ID, accessKeyId: good.R2_ACCESS_KEY_ID, secretAccessKey: good.R2_SECRET_ACCESS_KEY, bucket: "waytara-cadence" });
  });

  it("accept the endpoint address in place of the bare account id", () => {
    const id = "a".repeat(32);
    for (const v of [`https://${id}.r2.cloudflarestorage.com`, `https://${id}.r2.cloudflarestorage.com/`, ` ${id} `]) expect(loadConfig({ ...good, R2_ACCOUNT_ID: v }).r2?.accountId).toBe(id);
    expect(() => loadConfig({ ...good, R2_ACCOUNT_ID: "https://example.com" })).toThrow(/32 character account id/);
  });

  it("must all be set together, and are checked without echoing the secret", () => {
    expect(() => loadConfig({ R2_BUCKET: "waytara-cadence" })).toThrow(/must all be set together/);
    expect(() => loadConfig({ ...good, R2_ACCOUNT_ID: "short" })).toThrow(ConfigError);
    try {
      loadConfig({ ...good, R2_BUCKET: "Bad Bucket!", R2_SECRET_ACCESS_KEY: "x".repeat(40) });
    } catch (error) {
      expect((error as Error).message).not.toContain("x".repeat(40));
    }
  });
});

describe("the app without a file store", () => {
  it("starts, and the readiness report has no file-store check", async () => {
    const app = await testApp();
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.json().checks.cadence_store).toBeUndefined();
    await app.close();
  });
});
