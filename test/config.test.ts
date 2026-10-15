import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("fills in safe defaults", () => {
    const c = loadConfig({});
    expect(c.env).toBe("development");
    expect(c.port).toBe(3000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.trustProxy).toBe(false);
    expect(c.rateLimitMax).toBe(120);
    expect(c.bodyLimitBytes).toBe(262_144);
    expect(c.allowedOrigins).toContain("http://localhost:3000");
    expect(c.version).toBe("dev");
  });

  it("reads numbers, booleans and a list of websites", () => {
    const c = loadConfig({
      PORT: "10000",
      TRUST_PROXY: "true",
      RATE_LIMIT_MAX: "30",
      ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
    });
    expect(c.port).toBe(10000);
    expect(c.trustProxy).toBe(true);
    expect(c.rateLimitMax).toBe(30);
    expect(c.allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("uses the short Render commit as the version when no version is set", () => {
    expect(loadConfig({ RENDER_GIT_COMMIT: "0123456789abcdef" }).version).toBe("0123456");
    expect(loadConfig({ RENDER_GIT_COMMIT: "0123456789abcdef", APP_VERSION: "1.2.3" }).version).toBe("1.2.3");
  });

  it("rejects a bad port and names the setting", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: "70000" });
    } catch (e) {
      expect((e as ConfigError).problems.join(" ")).toMatch(/PORT/);
    }
  });

  it("rejects a website entry with a path or a trailing slash", () => {
    expect(() => loadConfig({ ALLOWED_ORIGINS: "https://a.example.com/app" })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_ORIGINS: "https://a.example.com/" })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_ORIGINS: "not a url" })).toThrow(ConfigError);
  });

  it("requires https websites in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "http://a.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "" })).toThrow(/at least one/);
    expect(loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://a.example.com" }).env).toBe("production");
  });

  it("never puts a value into the error message", () => {
    const secretish = "super-secret-value-123";
    try {
      loadConfig({ LOG_LEVEL: secretish, PORT: secretish });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(secretish);
    }
  });
});
