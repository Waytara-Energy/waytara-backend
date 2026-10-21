import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("health routes", () => {
  it("/healthz says the service is up and reveals nothing else", async () => {
    app = await testApp({ APP_VERSION: "9.9.9" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("9.9.9");
    expect(typeof body.uptime_s).toBe("number");
    expect(Object.keys(body).sort()).toEqual(["status", "uptime_s", "version"]);
  });

  it("/readyz is ok when nothing is registered", async () => {
    app = await testApp();
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: {} });
  });

  it("/readyz is ok when every check passes", async () => {
    app = await testApp();
    app.readiness.register("database", async () => {});
    app.readiness.register("storage", async () => {});
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual({ database: "ok", storage: "ok" });
  });

  it("/readyz returns 503 and hides the reason when a check fails", async () => {
    app = await testApp();
    app.readiness.register("database", async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
    });
    app.readiness.register("storage", async () => {});
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: { database: "fail", storage: "ok" } });
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("ECONNREFUSED");
  });

  it("/readyz returns 503 when a check is too slow", async () => {
    app = await testApp({ READINESS_TIMEOUT_MS: "100" });
    app.readiness.register("broker", () => new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()));
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ broker: "timeout" });
  });
});

describe("the database's 10-second tick call", () => {
  const SECRET = "tick-secret-0123456789abcdef";
  const tick = (headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/v1/internal/tick", headers });

  it("does not exist without HUB_TICK_SECRET", async () => {
    app = await testApp();
    const res = await tick({ authorization: `Bearer ${SECRET}` });
    expect(res.statusCode).toBe(404);
  });

  it("answers the right secret with the hub's uptime and version", async () => {
    app = await testApp({ APP_VERSION: "9.9.9", HUB_TICK_SECRET: SECRET });
    const res = await tick({ authorization: `Bearer ${SECRET}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ status: "ok", version: "9.9.9", boards_connected: null });
    expect(typeof body.uptime_s).toBe("number");
  });

  it("gives a wrong, missing or malformed secret the same plain 404", async () => {
    app = await testApp({ HUB_TICK_SECRET: SECRET });
    const wrong = await tick({ authorization: "Bearer not-the-secret-at-all" });
    const none = await tick();
    const short = await tick({ authorization: `Bearer ${SECRET}x` });
    for (const r of [wrong, none, short]) expect(r.statusCode).toBe(404);
    expect(wrong.body).toBe(none.body);
    expect(wrong.body).not.toContain(SECRET);
  });

  it("is not reachable with GET, and /healthz is unchanged", async () => {
    app = await testApp({ HUB_TICK_SECRET: SECRET });
    expect((await app.inject({ method: "GET", url: "/v1/internal/tick", headers: { authorization: `Bearer ${SECRET}` } })).statusCode).toBe(404);
    const health = (await app.inject({ method: "GET", url: "/healthz" })).json();
    expect(Object.keys(health).sort()).toEqual(["status", "uptime_s", "version"]);
  });
});
