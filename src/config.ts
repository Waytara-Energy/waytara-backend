import { z } from "zod";

/**
 * All settings come from environment variables and are checked once, at start-up, so a bad value stops the service
 * immediately with a clear message instead of failing later in the middle of a request.
 *
 * The error message names the variable and what is wrong. It never prints the value: a value can be a secret.
 */

const asBoolean = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** "https://a.example, https://b.example" -> ["https://a.example", "https://b.example"], each an origin (no path). */
const asOriginList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  )
  .superRefine((list, ctx) => {
    for (const item of list) {
      let origin: string | null = null;
      try {
        const u = new URL(item);
        if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
      } catch {
        origin = null;
      }
      if (origin === null || origin !== item) {
        ctx.addIssue({
          code: "custom",
          message: "each entry must be an origin such as https://example.com (no path, no trailing slash)",
        });
        return;
      }
    }
  });

const DEFAULT_DEV_ORIGINS = "http://localhost:3000,http://localhost:3001,http://localhost:5173";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    PUBLIC_BASE_URL: z.url().optional(),
    ALLOWED_ORIGINS: asOriginList.default(DEFAULT_DEV_ORIGINS.split(",")),
    TRUST_PROXY: asBoolean.default(false),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(120),
    RATE_LIMIT_WINDOW_S: z.coerce.number().int().min(1).max(3600).default(60),
    BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(262_144),
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
    APP_VERSION: z.string().min(1).max(64).optional(),
    RENDER_GIT_COMMIT: z.string().min(7).max(64).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    if (env.ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({ code: "custom", path: ["ALLOWED_ORIGINS"], message: "must list at least one website in production" });
    }
    for (const origin of env.ALLOWED_ORIGINS) {
      if (!origin.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["ALLOWED_ORIGINS"], message: "every website must be https in production" });
        break;
      }
    }
  });

export interface Config {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  publicBaseUrl?: string;
  allowedOrigins: string[];
  trustProxy: boolean;
  rateLimitMax: number;
  rateLimitWindowS: number;
  bodyLimitBytes: number;
  readinessTimeoutMs: number;
  version: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid settings:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join(".") : "settings";
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const e = parsed.data;
  const commit = e.RENDER_GIT_COMMIT ? e.RENDER_GIT_COMMIT.slice(0, 7) : undefined;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    ...(e.PUBLIC_BASE_URL ? { publicBaseUrl: e.PUBLIC_BASE_URL } : {}),
    allowedOrigins: e.ALLOWED_ORIGINS,
    trustProxy: e.TRUST_PROXY,
    rateLimitMax: e.RATE_LIMIT_MAX,
    rateLimitWindowS: e.RATE_LIMIT_WINDOW_S,
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    readinessTimeoutMs: e.READINESS_TIMEOUT_MS,
    version: e.APP_VERSION ?? commit ?? "dev",
  };
}
