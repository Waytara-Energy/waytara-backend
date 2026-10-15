import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DAY_MS, PartError, WINDOW_MS, dayKey, decodePart, encodePart, mergeRows, partKey, partStartFromKey, windowStartOf, type CadenceRow } from "../src/core/cadence-part.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const T0 = Date.UTC(2026, 9, 15, 8, 5, 0); // 2026-10-15 08:05:00 UTC, a window start
const row = (t: number, seq: number, words: Record<number, number>, boot = 7): CadenceRow => ({ t, boot, seq, words: new Map(Object.entries(words).map(([k, v]) => [Number(k), v])) });

describe("names", () => {
  it("puts a window in a folder per equipment and UTC day, named by its start", () => {
    expect(partKey(EQ, T0)).toBe(`cadence/v1/${EQ}/2026/10/15/0805.csv.gz`);
    expect(dayKey(EQ, Date.UTC(2026, 9, 15))).toBe(`cadence/v1/${EQ}/2026/10/15/day.csv.gz`);
    expect(partKey(EQ, Date.UTC(2026, 0, 2, 23, 55))).toBe(`cadence/v1/${EQ}/2026/01/02/2355.csv.gz`);
  });

  it("aligns times to five minutes", () => {
    expect(windowStartOf(T0 + 299_999)).toBe(T0);
    expect(windowStartOf(T0 + WINDOW_MS)).toBe(T0 + WINDOW_MS);
  });

  it("reads the window start back from a name, and refuses names that are not parts", () => {
    const day = Date.UTC(2026, 9, 15);
    expect(partStartFromKey(partKey(EQ, T0), day)).toBe(T0);
    expect(partStartFromKey(dayKey(EQ, day), day)).toBeNull();
    expect(partStartFromKey(`cadence/v1/${EQ}/2026/10/15/0807.csv.gz`, day)).toBeNull();
    expect(partStartFromKey(`cadence/v1/${EQ}/2026/10/15/2460.csv.gz`, day)).toBeNull();
    expect(partStartFromKey(`cadence/v1/${EQ}/2026/10/15/notes.txt`, day)).toBeNull();
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe("a part file", () => {
  it("keeps raw words exactly, with empty cells for registers a frame did not carry", () => {
    const rows = [row(T0 + 5000, 2, { 186: 120, 184: 80 }), row(T0, 1, { 186: 0, 184: 80, 603: 65535 }), row(T0 + 10_000, 3, { 603: 0 })];
    const back = decodePart(encodePart(EQ, new Date(T0).toISOString(), rows));
    expect(back.map((r) => [r.t, r.seq])).toEqual([[T0, 1], [T0 + 5000, 2], [T0 + 10_000, 3]]);
    expect(back[0]!.words.get(603)).toBe(65535);
    expect(back[0]!.words.get(186)).toBe(0); // zero is a reading, not an empty cell
    expect(back[1]!.words.has(603)).toBe(false);
    expect(back[2]!.words.has(186)).toBe(false);
    expect(back[2]!.words.get(603)).toBe(0);
  });

  it("is a gzipped CSV a person can open, with the register numbers as column names", () => {
    const text = gunzipSync(encodePart(EQ, "w", [row(T0, 1, { 184: 80, 186: 120 })])).toString("utf8");
    expect(text.split("\n").slice(0, 5)).toEqual(["# waytara-cadence 1", `# equipment=${EQ} window=w`, "ts_ms,boot,seq,r184,r186", `${T0},7,1,80,120`, ""]);
  });

  it("holds an empty window as just its header", () => {
    expect(decodePart(encodePart(EQ, "w", []))).toEqual([]);
  });

  it("refuses files that are not cadence files, or damaged", () => {
    expect(() => decodePart(Buffer.from("plain text"))).toThrow(PartError);
    expect(() => decodePart(gzipSync("hello\n"))).toThrow(/unknown format/);
    expect(() => decodePart(gzipSync("# waytara-cadence 1\n# x\nts,boot,seq\n"))).toThrow(/unknown header/);
    expect(() => decodePart(gzipSync("# waytara-cadence 1\n# x\nts_ms,boot,seq,speed\n"))).toThrow(/unknown column/);
    expect(() => decodePart(gzipSync("# waytara-cadence 1\n# x\nts_ms,boot,seq,r1\n1,1,1,70000\n"))).toThrow(/bad value/);
    expect(() => decodePart(gzipSync("# waytara-cadence 1\n# x\nts_ms,boot,seq,r1\nx,1,1,5\n"))).toThrow(/bad row/);
  });
});

describe("mergeRows", () => {
  it("keeps a frame once, the later list winning, and sorts by time", () => {
    const a = [row(T0 + 10_000, 3, { 1: 1 }), row(T0, 1, { 1: 1 })];
    const b = [row(T0, 1, { 1: 2 }), row(T0 + 5000, 2, { 1: 3 })];
    const m = mergeRows(a, b);
    expect(m.map((r) => [r.seq, r.words.get(1)])).toEqual([[1, 2], [2, 3], [3, 1]]);
  });

  it("treats the same sequence number in another boot as another frame", () => {
    expect(mergeRows([row(T0, 1, { 1: 1 }, 7)], [row(T0 + 1, 1, { 1: 1 }, 8)])).toHaveLength(2);
  });
});
