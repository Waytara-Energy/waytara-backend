import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AppError } from "../src/lib/errors.js";
import { PRODUCTION, appWithLogCapture, testApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("security headers", () => {
  it("sends the API hardening headers and no x-powered-by", async () => {
    app = await testApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("sends HSTS in production only", async () => {
    app = await testApp();
    expect((await app.inject({ method: "GET", url: "/healthz" })).headers["strict-transport-security"]).toBeUndefined();
    await app.close();
    app = await testApp(PRODUCTION);
    const prod = await app.inject({ method: "GET", url: "/healthz" });
    expect(prod.headers["strict-transport-security"]).toContain("max-age=15552000");
  });
});

describe("CORS", () => {
  it("allows a listed website", async () => {
    app = await testApp();
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "https://app.example.com" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("gives an unlisted website nothing to work with", async () => {
    app = await testApp();
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "https://evil.example.net" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight from a listed website and refuses an unlisted one", async () => {
    app = await testApp();
    const ok = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "https://admin.example.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://admin.example.com");
    expect(ok.headers["access-control-allow-headers"]).toContain("Authorization");

    const bad = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "https://evil.example.net", "access-control-request-method": "POST" },
    });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not add CORS headers to a call that has no Origin (a board or a server)", async () => {
    app = await testApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("rate limit", () => {
  it("stops a client that is too fast, with a JSON answer and Retry-After", async () => {
    app = await testApp({ RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_S: "60" });
    app.get("/ping", async () => ({ pong: true }));
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    }
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("limits unknown paths too, so probing for routes is not free", async () => {
    app = await testApp({ RATE_LIMIT_MAX: "3" });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: "GET", url: "/does-not-exist" })).statusCode);
    expect(codes).toEqual([404, 404, 404, 429, 429]);
  });

  it("never limits the health probe", async () => {
    app = await testApp({ RATE_LIMIT_MAX: "2" });
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    }
  });
});

describe("errors", () => {
  it("answers an unknown route with a JSON 404", async () => {
    app = await testApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("shows an AppError's message and code", async () => {
    app = await testApp();
    app.get("/denied", async () => {
      throw new AppError(403, "forbidden", "You cannot do that");
    });
    const res = await app.inject({ method: "GET", url: "/denied" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: "forbidden", message: "You cannot do that" });
  });

  it("hides the details of an unexpected error and returns a request id", async () => {
    app = await testApp();
    app.get("/boom", async () => {
      throw new Error("database password is hunter2");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(res.json().error).toMatchObject({ code: "internal", message: "Something went wrong" });
    expect(res.json().error.request_id).toBe(res.headers["x-request-id"]);
  });

  it("rejects a body over the limit with 413 and no detail", async () => {
    app = await testApp({ BODY_LIMIT_BYTES: "1024" });
    app.post("/echo", async (req) => ({ got: typeof req.body }));
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ blob: "x".repeat(5000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("answers broken JSON with 400", async () => {
    app = await testApp();
    app.post("/echo", async () => ({ ok: true }));
    const res = await app.inject({ method: "POST", url: "/echo", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  it("reports schema validation problems without echoing the values", async () => {
    app = await testApp();
    app.post(
      "/typed",
      { schema: { body: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } } },
      async () => ({ ok: true }),
    );
    const res = await app.inject({ method: "POST", url: "/typed", payload: { n: "secret-value" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(res.body).not.toContain("secret-value");
  });
});

describe("request ids", () => {
  it("keeps a sane caller id and replaces a bad one", async () => {
    app = await testApp();
    const good = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "abc-12345-trace" } });
    expect(good.headers["x-request-id"]).toBe("abc-12345-trace");
    const bad = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "<script>alert(1)</script>" } });
    expect(bad.headers["x-request-id"]).not.toContain("<");
    expect(String(bad.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("logs", () => {
  it("never write the authorization header or a secret query value", async () => {
    const captured = await appWithLogCapture();
    app = captured.app;
    await app.inject({
      method: "GET",
      url: "/healthz?ticket=TICKET-SECRET-1&page=2",
      headers: { authorization: "Bearer TOP-SECRET-JWT", cookie: "sid=COOKIE-SECRET" },
    });
    const text = captured.lines.join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("TOP-SECRET-JWT");
    expect(text).not.toContain("COOKIE-SECRET");
    expect(text).not.toContain("TICKET-SECRET-1");
    expect(text).toContain("page=2");
  });
});
