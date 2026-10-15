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
