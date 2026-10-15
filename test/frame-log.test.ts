import { describe, expect, it } from "vitest";
import { FrameLog, hideTags } from "../src/features/ocpp/frame-log.js";

describe("hiding card identifiers", () => {
  it("replaces every idTag value, also inside idTagInfo, and leaves the rest", () => {
    const out = hideTags('[2,"1","StartTransaction",{"idTag":"ABC123","meterStart":5}]');
    expect(out).toBe('[2,"1","StartTransaction",{"idTag":"[hidden]","meterStart":5}]');
    expect(hideTags('{"idTagInfo":{"status":"Accepted","parentIdTag":"P1"},"idTag" : "a\\"b"}')).toBe('{"idTagInfo":{"status":"Accepted","parentIdTag":"[hidden]"},"idTag" : "[hidden]"}');
  });
});

describe("the frame log", () => {
  it("keeps the newest frames per charger and cuts long ones", () => {
    const log = new FrameLog(() => Date.UTC(2026, 9, 15, 12, 0, 0));
    for (let i = 0; i < 350; i++) log.add("eq1", "in", `[2,"${i}","Heartbeat",{}]`);
    log.add("eq2", "out", "x".repeat(5000));
    expect(log.list("eq1")).toHaveLength(300);
    expect(log.list("eq1").at(-1)!.frame).toContain('"349"');
    expect(log.list("eq1", 5)).toHaveLength(5);
    expect(log.list("eq2")[0]!.frame.length).toBeLessThan(4100);
    expect(log.list("eq2")[0]!.at).toBe("2026-10-15T12:00:00.000Z");
    expect(log.list("nobody")).toEqual([]);
  });

  it("forgets the oldest charger when too many are tracked", () => {
    const log = new FrameLog();
    for (let i = 0; i < 205; i++) log.add(`eq${i}`, "in", "[]");
    expect(log.list("eq0")).toEqual([]);
    expect(log.list("eq204")).toHaveLength(1);
  });
});
