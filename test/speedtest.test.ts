import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SPEEDTEST_MAX_BYTES } from "../src/routes/speedtest.js";
import { testApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe("the speed test", () => {
  it("sends the number of bytes asked for, as raw data that is never cached", async () => {
    app = await testApp();
    const r = await app.inject({ method: "GET", url: "/v1/speedtest?bytes=1000" });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(1000);
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("sends 64 KB when no size is given, and never more than 256 KB", async () => {
    app = await testApp();
    expect((await app.inject({ method: "GET", url: "/v1/speedtest" })).rawPayload.length).toBe(65_536);
    expect((await app.inject({ method: "GET", url: `/v1/speedtest?bytes=${SPEEDTEST_MAX_BYTES}` })).rawPayload.length).toBe(SPEEDTEST_MAX_BYTES);
    expect((await app.inject({ method: "GET", url: `/v1/speedtest?bytes=${SPEEDTEST_MAX_BYTES + 1}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/speedtest?bytes=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/speedtest?bytes=abc" })).statusCode).toBe(400);
  });

  it("says how many bytes arrived from an upload", async () => {
    app = await testApp();
    const r = await app.inject({ method: "POST", url: "/v1/speedtest", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(4096, 7) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ received: 4096 });
  });

  it("refuses an upload that is too big", async () => {
    app = await testApp();
    const r = await app.inject({ method: "POST", url: "/v1/speedtest", headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(SPEEDTEST_MAX_BYTES + 1) });
    expect(r.statusCode).toBe(413);
  });

  it("limits how often one address can use it", async () => {
    app = await testApp();
    let last = 0;
    for (let i = 0; i < 14; i++) last = (await app.inject({ method: "GET", url: "/v1/speedtest?bytes=10" })).statusCode;
    expect(last).toBe(429);
  });
});
