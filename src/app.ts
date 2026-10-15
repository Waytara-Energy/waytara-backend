import Fastify, { type FastifyInstance } from "fastify";
import type { Writable } from "node:stream";
import type { Config } from "./config.js";
import { Readiness } from "./lib/readiness.js";
import { buildLoggerOptions } from "./logger.js";
import { registerSecurity, requestIdFrom } from "./plugins/security.js";
import { registerHealthRoutes } from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    readiness: Readiness;
    config: Config;
  }
}

export interface BuildOptions {
  /** Tests pass a stream to capture log lines, or false to silence them. */
  logger?: false | { stream: Writable };
}

/**
 * Builds the web application. Nothing here opens a port, so tests can call it and use app.inject().
 * Later tasks add their routes and dependencies in this function.
 */
export async function buildApp(config: Config, options: BuildOptions = {}): Promise<FastifyInstance> {
  const loggerOption =
    options.logger === false
      ? false
      : options.logger
        ? { ...buildLoggerOptions({ ...config, env: "test" }), stream: options.logger.stream }
        : buildLoggerOptions(config);

  const app = Fastify({
    logger: loggerOption,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    genReqId: (req) => requestIdFrom(req.headers["x-request-id"]),
    requestIdHeader: false,
  });

  const readiness = new Readiness();
  app.decorate("readiness", readiness);
  app.decorate("config", config);

  await registerSecurity(app, config);
  await registerHealthRoutes(app, config, readiness);

  return app;
}
