import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp, type Deps } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com",
    ...overrides,
  });
}

export async function testApp(overrides: Record<string, string> = {}, deps?: Partial<Deps>): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides), { logger: false, ...(deps ? { deps } : {}) });
  return app;
}

/** An app whose log lines are captured, to prove secrets never reach the log. */
export async function appWithLogCapture(overrides: Record<string, string> = {}, deps?: Partial<Deps>) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const app = await buildApp(testConfig({ LOG_LEVEL: "info", ...overrides }), { logger: { stream }, ...(deps ? { deps } : {}) });
  return { app, lines };
}

/** Everything production insists on, with harmless made-up values. */
export const PRODUCTION: Record<string, string> = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://project.example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key-anon-key-anon-key",
  SUPABASE_SERVICE_USER_EMAIL: "backend@example.com",
  SUPABASE_SERVICE_USER_PASSWORD: "a-long-password-from-a-manager",
  KEY_ENCRYPTION_MASTER: Buffer.alloc(32, 5).toString("base64"),
};
