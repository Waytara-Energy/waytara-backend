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

/** 32 random bytes written as base64 (44 characters). The value is never echoed in an error. */
const asMasterKey = z.string().transform((v, ctx) => {
  const buf = Buffer.from(v.trim(), "base64");
  if (buf.length !== 32 || buf.toString("base64") !== v.trim()) {
    ctx.addIssue({ code: "custom", message: "must be 32 random bytes written as base64 (44 characters)" });
    return z.NEVER;
  }
  return buf;
});

/** The 32 character Cloudflare account id; the S3 endpoint address that contains it is accepted too (it is what the dashboard shows next to it). */
const asR2AccountId = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => /^https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com\/?$/i.exec(v)?.[1] ?? v)
  .pipe(z.string().regex(/^[0-9a-f]{32}$/i, "must be the 32 character account id (or the endpoint address that contains it)"));

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
    SUPABASE_URL: z.url().optional(),
    SUPABASE_ANON_KEY: z.string().min(20).max(4096).optional(),
    SUPABASE_SERVICE_USER_EMAIL: z.email().optional(),
    SUPABASE_SERVICE_USER_PASSWORD: z.string().min(8).max(512).optional(),
    KEY_ENCRYPTION_MASTER: asMasterKey.optional(),
    KEY_ENCRYPTION_MASTER_PREVIOUS: asMasterKey.optional(),
    R2_ACCOUNT_ID: asR2AccountId.optional(),
    R2_ACCESS_KEY_ID: z.string().min(16).max(128).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(32).max(256).optional(),
    R2_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "must be a bucket name").optional(),
    /** false switches the MQTT broker and the data intake off (the key and claim endpoints keep working) */
    GATEWAY_INGEST: asBoolean.default(true),
    APP_VERSION: z.string().min(1).max(64).optional(),
    RENDER_GIT_COMMIT: z.string().min(7).max(64).optional(),
  })
  .superRefine((env, ctx) => {
    const supabase = [env.SUPABASE_URL, env.SUPABASE_ANON_KEY, env.SUPABASE_SERVICE_USER_EMAIL, env.SUPABASE_SERVICE_USER_PASSWORD];
    if (supabase.some((v) => v !== undefined) && supabase.some((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", path: ["SUPABASE_URL"], message: "SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_USER_EMAIL and SUPABASE_SERVICE_USER_PASSWORD must all be set together" });
    }
    const r2 = [env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET];
    if (r2.some((v) => v !== undefined) && r2.some((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", path: ["R2_ACCOUNT_ID"], message: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must all be set together" });
    }
    if (env.NODE_ENV !== "production") return;
    for (const [name, value] of [
      ["SUPABASE_URL", env.SUPABASE_URL],
      ["SUPABASE_ANON_KEY", env.SUPABASE_ANON_KEY],
      ["SUPABASE_SERVICE_USER_EMAIL", env.SUPABASE_SERVICE_USER_EMAIL],
      ["SUPABASE_SERVICE_USER_PASSWORD", env.SUPABASE_SERVICE_USER_PASSWORD],
      ["KEY_ENCRYPTION_MASTER", env.KEY_ENCRYPTION_MASTER],
    ] as const) {
      if (value === undefined) ctx.addIssue({ code: "custom", path: [name], message: "is required in production" });
    }
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
  /** present when the database settings are set; the key and claim features exist only then */
  supabase?: { url: string; anonKey: string; serviceEmail: string; servicePassword: string };
  keyMasters?: { current: Buffer; previous?: Buffer };
  /** the MQTT broker and the data intake run (default); false is the off switch */
  gatewayIngest: boolean;
  /** present when the file store (Cloudflare R2) is set; cadence data is kept and served only then */
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };
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
    ...(e.SUPABASE_URL && e.SUPABASE_ANON_KEY && e.SUPABASE_SERVICE_USER_EMAIL && e.SUPABASE_SERVICE_USER_PASSWORD
      ? { supabase: { url: e.SUPABASE_URL, anonKey: e.SUPABASE_ANON_KEY, serviceEmail: e.SUPABASE_SERVICE_USER_EMAIL, servicePassword: e.SUPABASE_SERVICE_USER_PASSWORD } }
      : {}),
    ...(e.KEY_ENCRYPTION_MASTER ? { keyMasters: { current: e.KEY_ENCRYPTION_MASTER, ...(e.KEY_ENCRYPTION_MASTER_PREVIOUS ? { previous: e.KEY_ENCRYPTION_MASTER_PREVIOUS } : {}) } } : {}),
    gatewayIngest: e.GATEWAY_INGEST,
    ...(e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_BUCKET
      ? { r2: { accountId: e.R2_ACCOUNT_ID, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, bucket: e.R2_BUCKET } }
      : {}),
    version: e.APP_VERSION ?? commit ?? "dev",
  };
}
