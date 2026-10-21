import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Readiness } from "../lib/readiness.js";

const startedAt = Date.now();

/** What the tick route says about the hub's own parts; filled in once the broker exists. */
export interface HubStatus {
  boardsConnected: () => number | null;
}

function secretMatches(header: string | undefined, secret: string): boolean {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerHealthRoutes(app: FastifyInstance, config: Config, readiness: Readiness, hub?: HubStatus): Promise<void> {
  // Liveness: the process is up. Used by Render's health check and by the uptime monitor. Reveals nothing sensitive.
  app.get("/healthz", async () => ({
    status: "ok",
    version: config.version,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
  }));

  // The database's 10-second heartbeat call (the one "fleet tick" in Supabase): it keeps the service awake and tells the database how
  // the hub is (uptime, boards connected). Without HUB_TICK_SECRET the route does not exist; a wrong secret gets the same plain 404.
  app.post("/v1/internal/tick", async (request, reply) => {
    if (!config.hubTickSecret || !secretMatches(request.headers.authorization, config.hubTickSecret)) {
      reply.status(404);
      return { error: { code: "not_found", message: "Not found" } };
    }
    reply.header("Cache-Control", "no-store");
    return {
      status: "ok",
      version: config.version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      boards_connected: hub?.boardsConnected() ?? null,
    };
  });

  // Readiness: every dependency (database, storage, broker...) answers in time. 503 tells a load balancer or a person to wait.
  app.get("/readyz", async (request, reply) => {
    const report = await readiness.run(config.readinessTimeoutMs, (name, error) => {
      request.log.warn({ check: name, err: error }, "readiness check failed");
    });
    reply.status(report.ok ? 200 : 503);
    return { status: report.ok ? "ok" : "unavailable", checks: report.checks };
  });
}
