import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { PRODUCTION } from "./helpers.js";

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

  it("runs the broker and the data intake unless GATEWAY_INGEST says false", () => {
    expect(loadConfig({}).gatewayIngest).toBe(true);
    expect(loadConfig({ GATEWAY_INGEST: "false" }).gatewayIngest).toBe(false);
    expect(loadConfig({ GATEWAY_INGEST: "0" }).gatewayIngest).toBe(false);
    expect(() => loadConfig({ GATEWAY_INGEST: "maybe" })).toThrow(ConfigError);
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
    expect(() => loadConfig({ ...PRODUCTION, ALLOWED_ORIGINS: "http://a.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ ...PRODUCTION, ALLOWED_ORIGINS: "" })).toThrow(/at least one/);
    expect(loadConfig({ ...PRODUCTION, ALLOWED_ORIGINS: "https://a.example.com" }).env).toBe("production");
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

  describe("database and key settings", () => {
    it("are optional outside production and then switch the key features off", () => {
      const c = loadConfig({});
      expect(c.supabase).toBeUndefined();
      expect(c.keyMasters).toBeUndefined();
    });

    it("are all required in production, and the error names each missing one", () => {
      try {
        loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://a.example.com" });
        throw new Error("should have thrown");
      } catch (e) {
        const text = (e as ConfigError).problems.join(" | ");
        for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_USER_EMAIL", "SUPABASE_SERVICE_USER_PASSWORD", "KEY_ENCRYPTION_MASTER"]) expect(text).toContain(name);
      }
    });

    it("must be given together or not at all", () => {
      expect(() => loadConfig({ SUPABASE_URL: "https://project.example.supabase.co" })).toThrow(/must all be set together/);
    });

    it("are read into one object each", () => {
      const c = loadConfig({ ...PRODUCTION, ALLOWED_ORIGINS: "https://a.example.com", KEY_ENCRYPTION_MASTER_PREVIOUS: Buffer.alloc(32, 6).toString("base64") });
      expect(c.supabase).toEqual({ url: "https://project.example.supabase.co", anonKey: "anon-key-anon-key-anon-key", serviceEmail: "backend@example.com", servicePassword: "a-long-password-from-a-manager" });
      expect(c.keyMasters?.current.equals(Buffer.alloc(32, 5))).toBe(true);
      expect(c.keyMasters?.previous?.equals(Buffer.alloc(32, 6))).toBe(true);
    });

    it("refuse a master key that is not 32 bytes of base64, without printing it", () => {
      for (const bad of ["too-short", Buffer.alloc(16).toString("base64"), Buffer.alloc(32, 1).toString("base64") + "x"]) {
        try {
          loadConfig({ KEY_ENCRYPTION_MASTER: bad });
          throw new Error("should have thrown");
        } catch (e) {
          expect((e as Error).message).toMatch(/KEY_ENCRYPTION_MASTER/);
          expect((e as Error).message).not.toContain(bad);
        }
      }
    });

    it("never put the password in an error message", () => {
      try {
        loadConfig({ SUPABASE_SERVICE_USER_PASSWORD: "x" });
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as Error).message).not.toContain("SUPABASE_SERVICE_USER_PASSWORD: x");
      }
    });
  });
});
