import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyVault } from "../src/core/key-vault.js";
import { CadenceWriter } from "../src/features/cadence/writer.js";
import type { EquipmentProfile } from "../src/features/ingest/store.js";
import { TokenError, type AuthUser, type TokenVerifier } from "../src/lib/jwt.js";
import { MemoryObjectStore } from "../src/storage/object-store.js";
import { FakeDb } from "./fakes.js";
import { FakeStore, defOf } from "./fake-store.js";
import { testApp } from "./helpers.js";

const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";
const SITE = "51000000-0000-4000-8000-000000000001";
const ADMIN = "a0000000-0000-4000-8000-000000000001";
const CUSTOMER = "c1000000-0000-4000-8000-000000000001";
const STRANGER = "c2000000-0000-4000-8000-000000000002";
const vault = new KeyVault({ current: Buffer.alloc(32, 3) });
const users: Record<string, AuthUser> = { "tok-admin": { id: ADMIN, role: "authenticated" }, "tok-customer": { id: CUSTOMER, role: "authenticated" }, "tok-stranger": { id: STRANGER, role: "authenticated" } };
const verify: TokenVerifier = async (t) => {
  const u = users[t];
  if (!u) throw new TokenError("no");
  return u;
};

const NOW = Date.UTC(2026, 9, 15, 10, 0, 0); // 2026-10-15 15:30 IST
const hour = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 15, h, m, s);

let app: FastifyInstance;
let db: FakeDb;
let objects: MemoryObjectStore;
let fakeNow = NOW;

const profile = (): EquipmentProfile => ({
  equipmentId: EQ,
  uploadIntervalS: 900,
  metrics: [defOf("pv1_power_w"), defOf("battery_power_w"), defOf("day_pv_energy_kwh"), { ...defOf("battery_soc_pct"), key: "internal_x", registers: [900], decode: null, showForUser: false }],
  labels: {
    pv1_power_w: { label: "PV1 power", unit: "W", category: "Solar" },
    battery_power_w: { label: "Battery power", unit: "W", category: "Battery" },
    day_pv_energy_kwh: { label: "Solar today", unit: "kWh", category: "Energy" },
    internal_x: { label: "Internal x", unit: null, category: "Internal" },
  },
});

beforeEach(async () => {
  fakeNow = NOW;
  db = new FakeDb();
  db.addEquipment({ equipmentId: EQ, siteId: SITE });
  db.cadence.set(`${ADMIN}|${EQ}`, "staff");
  db.cadence.set(`${CUSTOMER}|${EQ}`, "customer");
  objects = new MemoryObjectStore(() => fakeNow);
  const store = new FakeStore();
  store.profile = profile();
  // a morning of readings: PV1 100 W, then 200 W; a battery value; and an internal register
  const w = new CadenceWriter({ store: objects, log: { info: () => undefined, warn: () => undefined }, now: () => fakeNow });
  for (let i = 0; i < 12; i++) {
    w.add(EQ, [{ t: hour(8, 0, 0) + i * 5000, boot: 1, seq: i + 1, blocks: [[186, [i < 6 ? 100 : 200]], [190, [i === 3 ? 65476 : 10]], [900, [7]], ...(i === 0 ? ([[108, [123]]] as [number, number[]][]) : [])] }]);
  }
  await w.flushAll();
  app = await testApp({}, { db, verify, vault, store, objectStore: objects, clock: () => fakeNow });
});

afterEach(async () => {
  await app.close();
});

const get = (url: string, token = "tok-admin") => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
const q = (over: Record<string, string> = {}) => new URLSearchParams({ equipment: EQ, from: new Date(hour(7)).toISOString(), to: new Date(hour(9)).toISOString(), keys: "pv1_power_w,battery_power_w", ...over }).toString();

describe("which values a person can pick", () => {
  it("lists the values with names, units and groups; staff see everything", async () => {
    const r = await get(`/v1/reports/cadence/keys?equipment=${EQ}`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.scope).toBe("staff");
    expect(body.max_span_days).toBe(7);
    expect(body.keys.map((k: { key: string }) => k.key).sort()).toEqual(["battery_power_w", "day_pv_energy_kwh", "internal_x", "pv1_power_w"]);
    expect(body.keys.find((k: { key: string }) => k.key === "pv1_power_w")).toMatchObject({ label: "PV1 power", unit: "W", group: "Solar" });
    expect(r.headers["cache-control"]).toContain("no-store");
  });

  it("shows a customer only what customers see", async () => {
    const body = (await get(`/v1/reports/cadence/keys?equipment=${EQ}`, "tok-customer")).json();
    expect(body.scope).toBe("customer");
    expect(body.keys.map((k: { key: string }) => k.key)).not.toContain("internal_x");
  });

  it("answers 'not found' to anyone not allowed, as for unknown equipment", async () => {
    const stranger = await get(`/v1/reports/cadence/keys?equipment=${EQ}`, "tok-stranger");
    const unknown = await get("/v1/reports/cadence/keys?equipment=99999999-0000-4000-8000-000000000000");
    expect(stranger.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(stranger.json().error.code).toBe("not_found");
    expect(unknown.json().error.message).toBe(stranger.json().error.message);
  });

  it("needs a sign-in", async () => {
    expect((await app.inject({ method: "GET", url: `/v1/reports/cadence/keys?equipment=${EQ}` })).statusCode).toBe(401);
    expect((await get(`/v1/reports/cadence/keys?equipment=${EQ}`, "bogus")).statusCode).toBe(401);
  });
});

describe("a report as a file", () => {
  const body = (text: string) => text.replace(String.fromCharCode(0xfeff), "").trimEnd().split("\r\n");

  it("is a CSV with readable titles, India time and decoded values, one row per frame", async () => {
    const r = await get(`/v1/reports/cadence?${q()}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="waytara-cadence-b4c30eb8-2026-10-15.csv"');
    expect(r.headers["cache-control"]).toContain("no-store");
    const lines = body(r.body);
    expect(lines[0]).toBe("Time (IST),PV1 power (W),Battery power (W)");
    expect(lines).toHaveLength(13);
    expect(lines[1]).toBe("2026-10-15 13:30:00,100,10"); // 08:00 UTC is 13:30 in India
    expect(lines[4]).toBe("2026-10-15 13:30:15,100,-60");
    expect(lines[12]).toBe("2026-10-15 13:30:55,200,10");
  });

  it("starts with a byte-order mark so spreadsheets read it as UTF-8", async () => {
    const r = await get(`/v1/reports/cadence?${q()}`);
    expect(r.body.charCodeAt(0)).toBe(0xfeff);
  });

  it("keeps the order of the keys asked for", async () => {
    const r = await get(`/v1/reports/cadence?${q({ keys: "battery_power_w,pv1_power_w" })}`);
    expect(body(r.body)[0]).toBe("Time (IST),Battery power (W),PV1 power (W)");
  });

  it("covers only the period asked for", async () => {
    const r = await get(`/v1/reports/cadence?${q({ from: new Date(hour(8, 0, 20)).toISOString(), to: new Date(hour(8, 0, 40)).toISOString() })}`);
    expect(body(r.body)).toHaveLength(5); // header + 4 frames
  });

  it("accepts epoch milliseconds as well as ISO times", async () => {
    const r = await get(`/v1/reports/cadence?${q({ from: String(hour(7)), to: String(hour(9)) })}`);
    expect(r.statusCode).toBe(200);
  });

  it("joins days: several days of data come out as one file with one header", async () => {
    const w = new CadenceWriter({ store: objects, log: { info: () => undefined, warn: () => undefined }, now: () => fakeNow });
    w.add(EQ, [
      { t: hour(8) - 3 * 86_400_000, boot: 1, seq: 900, blocks: [[186, [50]]] },
      { t: hour(8) - 86_400_000, boot: 1, seq: 901, blocks: [[186, [60]]] },
    ]);
    await w.flushAll();
    const r = await get(`/v1/reports/cadence?${q({ from: new Date(hour(0) - 5 * 86_400_000).toISOString(), to: new Date(hour(9)).toISOString(), keys: "pv1_power_w" })}`);
    const lines = body(r.body);
    expect(lines.filter((l) => l.startsWith("Time"))).toHaveLength(1);
    expect(lines.slice(1, 3)).toEqual(["2026-10-12 13:30:00,50", "2026-10-14 13:30:00,60"]);
    expect(lines).toHaveLength(15);
  });
});

describe("a report as data", () => {
  it("answers JSON with the columns and one array per row, time in epoch milliseconds", async () => {
    const r = await get(`/v1/reports/cadence?${q({ format: "json" })}`);
    const b = r.json();
    expect(b.columns).toEqual([
      { key: "pv1_power_w", label: "PV1 power", unit: "W" },
      { key: "battery_power_w", label: "Battery power", unit: "W" },
    ]);
    expect(b.rows).toHaveLength(12);
    expect(b.rows[0]).toEqual([hour(8), 100, 10]);
    expect(b.rows[3]).toEqual([hour(8, 0, 15), 100, -60]);
    expect(b.truncated).toBe(false);
  });

  it("stops at the limit and says so", async () => {
    const b = (await get(`/v1/reports/cadence?${q({ format: "json", limit: "5" })}`)).json();
    expect(b.rows).toHaveLength(5);
    expect(b.truncated).toBe(true);
  });

  it("only has rows for frames that carried what was asked for", async () => {
    const b = (await get(`/v1/reports/cadence?${q({ format: "json", keys: "day_pv_energy_kwh" })}`)).json();
    expect(b.rows).toEqual([[hour(8), 12.3]]);
  });
});

describe("who gets what", () => {
  it("lets staff read every value", async () => {
    expect((await get(`/v1/reports/cadence?${q({ keys: "internal_x" })}`)).statusCode).toBe(200);
  });

  it("refuses a customer a value customers do not see, without confirming it exists", async () => {
    const hidden = await get(`/v1/reports/cadence?${q({ keys: "internal_x" })}`, "tok-customer");
    const missing = await get(`/v1/reports/cadence?${q({ keys: "no_such_thing" })}`, "tok-customer");
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json().error.message).toBe(missing.json().error.message);
  });

  it("gives a customer their own values", async () => {
    expect((await get(`/v1/reports/cadence?${q()}`, "tok-customer")).statusCode).toBe(200);
  });

  it("refuses someone with no access as for unknown equipment", async () => {
    expect((await get(`/v1/reports/cadence?${q()}`, "tok-stranger")).statusCode).toBe(404);
  });
});

describe("the limits", () => {
  const bad = async (over: Record<string, string>, text: RegExp) => {
    const r = await get(`/v1/reports/cadence?${q(over)}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(text);
  };

  it("allows at most a week per file", async () => {
    await bad({ from: new Date(hour(9) - 7 * 86_400_000 - 1000).toISOString(), to: new Date(hour(9)).toISOString() }, /at most 7 days/);
    expect((await get(`/v1/reports/cadence?${q({ from: new Date(hour(9) - 7 * 86_400_000).toISOString() })}`)).statusCode).toBe(200);
  });

  it("keeps four weeks of history", async () => {
    await bad({ from: new Date(NOW - 28 * 86_400_000 - 60_000).toISOString(), to: new Date(NOW - 27 * 86_400_000).toISOString() }, /28 days/);
    expect((await get(`/v1/reports/cadence?${q({ from: new Date(NOW - 28 * 86_400_000 + 60_000).toISOString(), to: new Date(NOW - 27 * 86_400_000).toISOString() })}`)).statusCode).toBe(200);
  });

  it("refuses an end before the start, and a period that has not happened", async () => {
    await bad({ from: new Date(hour(9)).toISOString(), to: new Date(hour(8)).toISOString() }, /after the start/);
    await bad({ from: new Date(NOW + 3_600_000).toISOString(), to: new Date(NOW + 7_200_000).toISOString() }, /not happened/);
  });

  it("cuts a period that runs into the future at now", async () => {
    const b = (await get(`/v1/reports/cadence?${q({ format: "json", to: new Date(NOW + 86_400_000).toISOString() })}`)).json();
    expect(b.to).toBe(NOW);
  });

  it("allows between 1 and 40 values", async () => {
    await bad({ keys: Array.from({ length: 41 }, (_, i) => `k${i}`).join(",") }, /between 1 and 40/);
    await bad({ keys: "," }, /between 1 and 40/);
  });

  it("refuses a request that is not in the expected shape, naming the problem and never the value", async () => {
    const r = await get("/v1/reports/cadence?equipment=nope&from=x&to=y&keys=a");
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).not.toContain("nope");
  });
});

describe("when the file store is down", () => {
  it("answers 503 with a plain message, before sending anything", async () => {
    objects.failNext = 5;
    const r = await get(`/v1/reports/cadence?${q()}`);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toMatch(/unavailable/);
    expect(r.body).not.toMatch(/store|R2|bucket/i);
  });
});
