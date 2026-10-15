import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Readiness } from "../lib/readiness.js";

const startedAt = Date.now();

export async function registerHealthRoutes(app: FastifyInstance, config: Config, readiness: Readiness): Promise<void> {
  // Liveness: the process is up. Used by Render's health check and by the uptime monitor. Reveals nothing sensitive.
  app.get("/healthz", async () => ({
    status: "ok",
    version: config.version,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  }));

  // Readiness: every dependency (database, storage, broker...) answers in time. 503 tells a load balancer or a person to wait.
  app.get("/readyz", async (request, reply) => {
    const report = await readiness.run(config.readinessTimeoutMs, (name, error) => {
      request.log.warn({ check: name, err: error }, "readiness check failed");
    });
    reply.status(report.ok ? 200 : 503);
    return { status: report.ok ? "ok" : "unavailable", checks: report.checks };
  });
}
