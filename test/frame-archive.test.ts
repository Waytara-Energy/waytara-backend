import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FrameArchive } from "../src/features/ocpp/frame-archive.js";
import { MemoryObjectStore } from "../src/storage/object-store.js";

const log = { info: () => undefined, warn: () => undefined };
const EQ = "ca7809ea-cfc9-4dd3-aeba-cd245a84e7ca";
let clock = Date.UTC(2026, 9, 15, 10, 30, 5);

const make = (store = new MemoryObjectStore(() => clock), retentionDays = 90) => ({ store, archive: new FrameArchive({ store, log, now: () => clock, retentionDays }) });

describe("the long-term message log", () => {
  it("writes the collected messages as one gzipped file of JSON lines, with card identifiers hidden", async () => {
    const { store, archive } = make();
    archive.add(EQ, "in", '[2,"1","Authorize",{"idTag":"CARD-9"}]');
    archive.add(EQ, "out", '[3,"1",{"idTagInfo":{"status":"Accepted"}}]');
    await archive.flush();
    const keys = [...store.files.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^ocpp/v1/${EQ}/2026/10/15/103005-[0-9a-f]{4}-1\.ndjson\.gz$`));
    const text = gunzipSync(store.files.get(keys[0]!)!).toString("utf8");
    expect(text).not.toContain("CARD-9");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { t: "2026-10-15T10:30:05.000Z", d: "in", f: '[2,"1","Authorize",{"idTag":"[hidden]"}]' },
      { t: "2026-10-15T10:30:05.000Z", d: "out", f: '[3,"1",{"idTagInfo":{"status":"Accepted"}}]' },
    ]);
  });

  it("writes nothing when nothing happened, and never rewrites a file", async () => {
    const { store, archive } = make();
    await archive.flush();
    expect(store.files.size).toBe(0);
    archive.add(EQ, "in", "[]");
    await archive.flush();
    clock += 1000;
    archive.add(EQ, "in", "[]");
    await archive.flush();
    expect(store.files.size).toBe(2);
  });

  it("keeps the messages when the file store fails and writes them next time", async () => {
    const { store, archive } = make();
    archive.add(EQ, "in", '[2,"1","Heartbeat",{}]');
    store.failNext = 1;
    await archive.flush();
    expect(archive.failures).toBe(1);
    expect(store.files.size).toBe(0);
    archive.add(EQ, "in", '[2,"2","Heartbeat",{}]');
    await archive.flush();
    const text = gunzipSync([...store.files.values()][0]!).toString("utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  it("reads a day back in order, across files", async () => {
    const { archive } = make();
    archive.add(EQ, "in", '[2,"1","Heartbeat",{}]');
    await archive.flush();
    clock += 60_000;
    archive.add(EQ, "in", '[2,"2","Heartbeat",{}]');
    await archive.flush();
    const day = await archive.readDay(EQ, "2026-10-15");
    expect(day.lines.map((l) => JSON.parse(l).f)).toEqual(['[2,"1","Heartbeat",{}]', '[2,"2","Heartbeat",{}]']);
    expect(day.truncated).toBe(false);
    expect((await archive.readDay(EQ, "2026-10-14")).lines).toEqual([]);
    expect((await archive.readDay(EQ, "2026-10-15", 1)).truncated).toBe(true);
  });

  it("removes files older than the retention and keeps the rest", async () => {
    const { store, archive } = make(undefined, 30);
    await store.put(`ocpp/v1/${EQ}/2026/08/01/000000-aaaa-1.ndjson.gz`, Buffer.from("x"));
    await store.put(`ocpp/v1/${EQ}/2026/09/20/000000-aaaa-1.ndjson.gz`, Buffer.from("x"));
    archive.add(EQ, "in", "[]");
    await archive.flush();
    expect(await archive.sweep()).toBe(1);
    expect([...store.files.keys()].some((k) => k.includes("/2026/08/01/"))).toBe(false);
    expect([...store.files.keys()].some((k) => k.includes("/2026/09/20/"))).toBe(true);
    expect([...store.files.keys()].some((k) => k.includes("/2026/10/15/"))).toBe(true);
  });
});
