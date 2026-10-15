import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com",
    ...overrides,
  });
}

export async function testApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides), { logger: false });
  return app;
}

/** An app whose log lines are captured, to prove secrets never reach the log. */
export async function appWithLogCapture(overrides: Record<string, string> = {}) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const app = await buildApp(testConfig({ LOG_LEVEL: "info", ...overrides }), { logger: { stream } });
  return { app, lines };
}
