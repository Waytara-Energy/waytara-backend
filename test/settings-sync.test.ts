import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { MetricDef } from "../src/core/decode.js";
import { KeyVault } from "../src/core/key-vault.js";
import { open, seal } from "../src/core/seal.js";
import { KeyCache } from "../src/features/broker/key-cache.js";
import { dnTopic, upTopic } from "../src/features/broker/topics.js";
import { IngestService } from "../src/features/ingest/service.js";
import type { PendingWrite, SettingRow, SettingsStore } from "../src/features/ingest/settings.js";
import { FakeDb } from "./fakes.js";
import { FakeStore } from "./fake-store.js";

const EQ = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE = "51000000-0000-4000-8000-000000000001";
const S = 1_792_044_000;
const key = Buffer.alloc(32, 9);
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const silent = { info: () => undefined, warn: () => undefined };

// Settings of this test: a plain one with a range, a scaled one, a yes/no bit field, and one the catalogue has not verified.
const setting = (key: string, register: number, over: Partial<MetricDef>): MetricDef => ({ key, direction: "write", registers: [register], decode: { scale: 1 }, showForUser: true, verified: true, valueKind: "number", cadenceSeconds: 300, ...over });
const SETTINGS: MetricDef[] = [
  setting("t_soc", 900, { validMin: 0, validMax: 100 }),
  setting("t_volt", 901, { decode: { scale: 0.1 }, validMin: 40, validMax: 60 }),
  setting("t_flag", 902, { decode: { bitmask: "0x0004" }, valueKind: "bool" }),
  setting("t_unverified", 903, { verified: false }),
];

/** The in-memory settings log and request list that stand in for equipment_configs. */
class SettingsFakeStore extends FakeStore implements SettingsStore {
  pending: PendingWrite[] = [];
  reported: { rows: SettingRow[] }[] = [];
  last = new Map<string, string>();
  failReport = 0;
  async pendingWrites(): Promise<PendingWrite[]> {
    return this.pending;
  }
  async reportSettings(_eq: string, rows: SettingRow[]): Promise<number> {
    if (this.failReport > 0) {
      this.failReport--;
      throw new Error("database down");
    }
    this.reported.push({ rows });
    // what the real function does: a request is answered, so it stops being pending
    for (const r of rows) {
      this.pending = this.pending.filter((p) => p.key !== r.key_name);
      this.last.set(r.key_name, r.setting_value);
    }
    return rows.length;
  }
  async lastSettings(): Promise<Map<string, string>> {
    return new Map(this.last);
  }
  get rows(): SettingRow[] {
    return this.reported.flatMap((r) => r.rows);
  }
}

let db: FakeDb;
let store: SettingsFakeStore;
let nowMs: number;
let counter: number;
let published: { topic: string; payload: Buffer }[];
let svc: IngestService;

const mk = (allowUnverifiedWrites = false) =>
  new IngestService({
    keys: new KeyCache(db, vault, 30_000, () => nowMs),
    store,
    settingsStore: store,
    allowUnverifiedWrites,
    publish: async (_id, topic, payload) => {
      published.push({ topic, payload });
    },
    log: silent,
    now: () => nowMs,
  });

const sealUp = (name: "data" | "hb" | "evt", body: unknown) => seal(body, { equipmentKey: key, equipmentId: EQ, direction: "up", topic: upTopic(EQ, name), counter: ++counter });
const heartbeat = () => svc.handleUp(EQ, "hb", sealUp("hb", { boot: 7, uptime_s: 100, inverter_online: true, map_ver: 1 }));
let seq = 0;
/** A data frame holding the settings registers: soc, volt (x0.1), flag word. */
const frame = (v: { soc?: number; volt?: number; flagWord?: number } = {}) =>
  svc.handleUp(EQ, "data", sealUp("data", { boot: 7, frames: [{ t: nowMs, seq: ++seq, blocks: [[900, [v.soc ?? 20]], [901, [v.volt ?? 500]], [902, [v.flagWord ?? 0]], [903, [5]]] }] }));
const commands = () => published.filter((p) => p.topic === dnTopic(EQ, "cmd")).map((p) => open<Record<string, unknown>>(p.payload, { equipmentKey: key, equipmentId: EQ, direction: "dn", topic: dnTopic(EQ, "cmd") }).body);
const answer = (id: string, body: Record<string, unknown>) => svc.handleUp(EQ, "evt", sealUp("evt", { type: "write_result", id, ...body }));
const request = (id: number, k: string, value: string, by: string | null = "c1000000-0000-4000-8000-000000000001") => store.pending.push({ id, key: k, value, by });

const catalogue = JSON.parse(readFileSync(new URL("./fixtures/catalogue.json", import.meta.url), "utf8")) as { metrics: MetricDef[] };

beforeEach(async () => {
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  await db.createKey({ equipmentId: EQ, kind: "gateway", ciphertext: vault.encrypt(key, { equipmentId: EQ, kind: "gateway" }), fingerprint: "abcdef012345", actor: "a" });
  store = new SettingsFakeStore();
  store.profile = { ...store.profile!, metrics: [...catalogue.metrics, ...SETTINGS] };
  nowMs = S * 1000 + 5000;
  counter = 0;
  seq = 0;
  published = [];
  svc = mk();
  await heartbeat(); // the board is alive
});

const round = async (advanceMs = 6000) => {
  nowMs += advanceMs;
  await heartbeat();
  await svc.tick(nowMs);
};

describe("a person's change reaches the inverter", () => {
  it("sends a sealed command with the register, the mask and the raw value, then records the read-back as confirmed", async () => {
    await frame(); // the unit's first report of its settings
    await round();
    store.reported.length = 0;
    request(11, "t_volt", "52.5");
    await round();
    const cmds = commands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ type: "write", key: "t_volt", reg: 901, mask: 0xffff, raw: 525 });
    expect(cmds[0]!.expires_at as number).toBeGreaterThan(nowMs);
    expect((cmds[0]!.expires_at as number) - (cmds[0]!.issued_at as number)).toBeLessThanOrEqual(60_000);

    await answer(cmds[0]!.id as string, { ok: true, readback: 525 });
    expect(store.rows).toEqual([{ key_name: "t_volt", setting_value: "52.5", source: "agent_write_ok", previous_value: "50", written_by: "c1000000-0000-4000-8000-000000000001" }]);
  });

  it("writes only the bits of a yes/no setting", async () => {
    request(12, "t_flag", "true");
    await round();
    expect(commands()[0]).toMatchObject({ key: "t_flag", reg: 902, mask: 0x0004, raw: 1 });
    await answer(commands()[0]!.id as string, { ok: true, readback: 1 });
    expect(store.rows.at(-1)).toMatchObject({ key_name: "t_flag", setting_value: "1", source: "agent_write_ok" });
  });

  it("does not send the same request twice", async () => {
    request(13, "t_soc", "30");
    await round();
    await round();
    await round();
    expect(commands()).toHaveLength(1);
  });

  it("records a failed write with what the inverter still holds and why", async () => {
    await frame({ soc: 20 });
    await round();
    store.reported.length = 0;
    request(14, "t_soc", "30");
    await round();
    await answer(commands()[0]!.id as string, { ok: false, readback: 20, error: "The inverter did not keep the value" });
    expect(store.rows).toEqual([{ key_name: "t_soc", setting_value: "20", source: "agent_write_failed", previous_value: "30", notes: "The inverter did not keep the value", written_by: "c1000000-0000-4000-8000-000000000001" }]);
  });

  it("reports a request nobody answered as failed after a minute", async () => {
    request(15, "t_soc", "30");
    await round();
    expect(commands()).toHaveLength(1);
    await round(61_000);
    expect(store.rows.at(-1)).toMatchObject({ key_name: "t_soc", source: "agent_write_failed", notes: expect.stringContaining("did not answer") });
  });

  it("ignores an answer to a command it did not send, and a repeated answer", async () => {
    request(16, "t_soc", "30");
    await round();
    const id = commands()[0]!.id as string;
    await answer("w-not-ours", { ok: true, readback: 30 });
    expect(store.rows.filter((r) => r.source === "agent_write_ok")).toHaveLength(0);
    await answer(id, { ok: true, readback: 30 });
    await answer(id, { ok: true, readback: 30 });
    expect(store.rows.filter((r) => r.source === "agent_write_ok")).toHaveLength(1);
  });
});

describe("what is refused, in plain words, without a command", () => {
  it("a setting the catalogue has not verified", async () => {
    request(21, "t_unverified", "7");
    await round();
    expect(commands()).toHaveLength(0);
    expect(store.rows.at(-1)).toMatchObject({ key_name: "t_unverified", source: "agent_write_failed", notes: expect.stringContaining("not been verified") });
  });

  it("but sends it when unverified writes are switched on", async () => {
    svc = mk(true);
    await heartbeat();
    request(22, "t_unverified", "7");
    await round();
    expect(commands()).toHaveLength(1);
  });

  it("a value outside the range, saying the range", async () => {
    request(23, "t_soc", "150");
    await round();
    expect(commands()).toHaveLength(0);
    expect(store.rows.at(-1)).toMatchObject({ source: "agent_write_failed", notes: expect.stringContaining("0 to 100") });
  });

  it("a value that is not a number", async () => {
    request(24, "t_soc", "high");
    await round();
    expect(commands()).toHaveLength(0);
    expect(store.rows.at(-1)).toMatchObject({ source: "agent_write_failed", notes: expect.stringContaining("not a number") });
  });

  it("a setting this unit does not have", async () => {
    request(25, "no_such_setting", "1");
    await round();
    expect(commands()).toHaveLength(0);
    expect(store.rows.at(-1)).toMatchObject({ key_name: "no_such_setting", source: "agent_write_failed" });
  });

  it("nothing is sent to a board that has stopped checking in, and the request stays", async () => {
    request(26, "t_soc", "30");
    nowMs += 90_000; // no heartbeat since
    await svc.tick(nowMs);
    expect(commands()).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    expect(store.pending).toHaveLength(1);
    await heartbeat(); // it comes back
    nowMs += 6000;
    await svc.tick(nowMs);
    expect(commands()).toHaveLength(1);
  });

  it("retries recording a refusal when the database is down at that moment", async () => {
    store.failReport = 1;
    request(27, "t_soc", "150");
    await round(); // the refusal could not be recorded
    expect(store.rows).toHaveLength(0);
    await round();
    expect(store.rows.at(-1)).toMatchObject({ key_name: "t_soc", source: "agent_write_failed" });
  });
});

describe("what the unit holds is recorded as the settings log's device word", () => {
  it("records each setting once at first sight, and again only when it changes", async () => {
    await frame({ soc: 20, volt: 500, flagWord: 0 });
    await round();
    const first = store.rows.filter((r) => r.source === "agent_initial_read").map((r) => `${r.key_name}=${r.setting_value}`);
    expect(first).toEqual(expect.arrayContaining(["t_soc=20", "t_volt=50", "t_flag=0"]));
    const n = store.rows.length;
    await frame({ soc: 20, volt: 500, flagWord: 0 });
    await round();
    expect(store.rows).toHaveLength(n); // unchanged: nothing new
    await frame({ soc: 25 }); // somebody changed it on the inverter's own screen
    await round();
    expect(store.rows.at(-1)).toMatchObject({ key_name: "t_soc", setting_value: "25", source: "agent_initial_read" });
  });

  it("does not record the unit's old value while a person's request for it is waiting", async () => {
    await frame({ soc: 20 });
    await round();
    store.reported.length = 0;
    request(31, "t_soc", "40");
    await frame({ soc: 20 }); // still the old value
    await round();
    expect(store.rows.filter((r) => r.key_name === "t_soc" && r.source === "agent_initial_read")).toHaveLength(0);
    expect(commands()).toHaveLength(1);
  });

  it("starts from what the log already says, so a restart does not repeat everything", async () => {
    store.last = new Map([["t_soc", "20"], ["t_volt", "50"], ["t_flag", "0"], ["t_unverified", "5"]]);
    svc = mk();
    await heartbeat();
    await frame({ soc: 20, volt: 500, flagWord: 0 });
    await round();
    expect(store.rows.filter((r) => r.source === "agent_initial_read")).toHaveLength(0);
  });
});
