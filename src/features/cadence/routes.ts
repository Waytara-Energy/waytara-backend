import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decodeMetric } from "../../core/decode.js";
import { DbError, type GatewayDb } from "../../db/gateway-db.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { userLimited } from "../../plugins/auth.js";
import type { EquipmentProfile, IngestStore } from "../ingest/store.js";
import type { CadenceArchive } from "./archive.js";
import { availableColumns, csvHeader, csvLines, decodeRows, pickColumns, type ReportColumn, type Scope } from "./report.js";

/** One file covers at most a week; the history is kept for four weeks (plan section 11.3). */
export const REPORT_MAX_SPAN_MS = 7 * 86_400_000;
export const REPORT_RETENTION_MS = 28 * 86_400_000;
export const REPORT_MAX_KEYS = 40;
const CHUNK_MS = 86_400_000;
const PROFILE_TTL_MS = 60_000;

const instant = z
  .string()
  .min(1)
  .max(40)
  .transform((s, ctx) => {
    const ms = /^\d{10,14}$/.test(s) ? Number(s) : Date.parse(s);
    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: "custom", message: "must be a time (ISO 8601 or epoch milliseconds)" });
      return z.NEVER;
    }
    return ms;
  });

const keysQuery = z.object({ equipment: z.uuid() });
const reportQuery = z.object({
  equipment: z.uuid(),
  from: instant,
  to: instant,
  keys: z
    .string()
    .min(1)
    .max(4000)
    .transform((s) => s.split(",").map((k) => k.trim()).filter(Boolean)),
  format: z.enum(["csv", "json"]).default("csv"),
  limit: z.coerce.number().int().min(1).max(20_000).default(500),
});

const idParam = z.object({ id: z.uuid() });
/** raw register blocks as the unit sends them over Bluetooth: [start, "4 hex digits per register"] */
const decodeBody = z.object({
  blocks: z
    .array(z.tuple([z.number().int().min(0).max(65_535), z.string().regex(/^(?:[0-9a-fA-F]{4}){1,125}$/)]))
    .min(1)
    .max(64),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw badRequest("The request did not match the expected shape", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export interface CadenceRouteDeps {
  db: Pick<GatewayDb, "cadenceAccess">;
  store: Pick<IngestStore, "loadProfile">;
  archive: Pick<CadenceArchive, "read">;
  now?: () => number;
}

export async function registerCadenceRoutes(app: FastifyInstance, d: CadenceRouteDeps): Promise<void> {
  const now = d.now ?? Date.now;
  const profiles = new Map<string, { at: number; profile: EquipmentProfile }>();

  /** Who may read this equipment's data, and its catalogue. Anyone not allowed gets the same "not found" as for unknown equipment. */
  async function access(actor: string, equipmentId: string): Promise<{ scope: Scope; columns: ReportColumn[] }> {
    let scope: Scope | null;
    try {
      scope = await d.db.cadenceAccess(actor, equipmentId);
    } catch (error) {
      if (error instanceof DbError && error.kind === "not_found") throw notFound();
      throw error;
    }
    if (!scope) throw notFound();
    const hit = profiles.get(equipmentId);
    let profile = hit && now() - hit.at < PROFILE_TTL_MS ? hit.profile : null;
    if (!profile) {
      profile = await d.store.loadProfile(equipmentId);
      if (!profile) throw notFound();
      profiles.set(equipmentId, { at: now(), profile });
      if (profiles.size > 200) profiles.delete(profiles.keys().next().value as string);
    }
    return { scope, columns: availableColumns(profile, scope) };
  }


  // The values this person can pick from, with the names and units shown to people.
  app.get("/v1/reports/cadence/keys", userLimited(app, 30), async (request, reply) => {
    const q = parse(keysQuery, request.query);
    const { scope, columns } = await access(request.user!.id, q.equipment);
    reply.header("Cache-Control", "private, no-store");
    return {
      scope,
      retention_days: 28,
      max_span_days: 7,
      max_keys: REPORT_MAX_KEYS,
      keys: columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit, group: c.category, cadence_s: c.cadenceSeconds })),
    };
  });

  app.get("/v1/reports/cadence", userLimited(app, 30), async (request, reply) => {
    const q = parse(reportQuery, request.query);
    const t = now();
    if (q.to <= q.from) throw badRequest("The end must be after the start.");
    if (q.to - q.from > REPORT_MAX_SPAN_MS) throw badRequest("One download covers at most 7 days.");
    if (q.from < t - REPORT_RETENTION_MS) throw badRequest("The readings are kept for 28 days.");
    if (q.keys.length === 0 || q.keys.length > REPORT_MAX_KEYS) throw badRequest(`Pick between 1 and ${REPORT_MAX_KEYS} values.`);
    const to = Math.min(q.to, t);
    if (to <= q.from) throw badRequest("That period has not happened yet.");

    const { columns: available } = await access(request.user!.id, q.equipment);
    const picked = pickColumns(available, q.keys);
    if (!picked.ok) throw badRequest("Some of those values are not available.", { unknown: picked.unknown });
    const columns = picked.columns;

    const chunks: [number, number][] = [];
    for (let a = q.from; a < to; a += CHUNK_MS) chunks.push([a, Math.min(a + CHUNK_MS, to)]);
    const readChunk = async ([a, b]: [number, number]) => decodeRows(await d.archive.read(q.equipment, a, b), columns);

    let first: ReturnType<typeof decodeRows>;
    try {
      first = await readChunk(chunks[0]!);
    } catch (error) {
      request.log.error({ err: error instanceof Error ? error.message : String(error) }, "reading cadence data failed");
      throw new AppError(503, "unavailable", "The readings are unavailable right now. Try again in a moment.");
    }

    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");

    if (q.format === "json") {
      let rows = first;
      for (let i = 1; i < chunks.length && rows.length < q.limit; i++) rows = rows.concat(await readChunk(chunks[i]!));
      return {
        columns: columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit })),
        rows: rows.slice(0, q.limit).map((r) => [r.t, ...r.cells]),
        truncated: rows.length > q.limit,
        from: q.from,
        to,
      };
    }

    async function* body(): AsyncGenerator<string> {
      yield "﻿" + csvHeader(columns);
      yield csvLines(first);
      let next = chunks.length > 1 ? readChunk(chunks[1]!) : null;
      for (let i = 1; i < chunks.length; i++) {
        const rows = await next!;
        next = i + 1 < chunks.length ? readChunk(chunks[i + 1]!) : null;
        next?.catch(() => undefined); // reported when its turn comes
        yield csvLines(rows);
      }
    }

    const day = new Date(q.from + 19_800_000).toISOString().slice(0, 10);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="waytara-cadence-${q.equipment.slice(0, 8)}-${day}.csv"`);
    return reply.send(Readable.from(body()));
  });

  // Turns raw register words (what the unit shows live over Bluetooth) into values, with the same rules as the stored readings. The page never
  // decodes anything itself. A customer gets only the values the customer view shows.
  app.post("/v1/equipment/:id/decode", userLimited(app, 90), async (request, reply) => {
    const { id } = parse(idParam, request.params);
    const body = parse(decodeBody, request.body);
    const { columns } = await access(request.user!.id, id);
    const words = new Map<number, number>();
    for (const [start, hex] of body.blocks) for (let i = 0; i < hex.length / 4; i++) words.set(start + i, parseInt(hex.slice(4 * i, 4 * i + 4), 16));
    const values: { key: string; label: string; unit: string | null; group: string | null; value: number | string; in_range: boolean }[] = [];
    for (const c of columns) {
      if (!c.def.registers.every((r) => words.has(r))) continue;
      const r = decodeMetric(c.def, words);
      if (r.ok) values.push({ key: c.key, label: c.label, unit: c.unit, group: c.category, value: r.value, in_range: r.inRange });
    }
    reply.header("Cache-Control", "no-store");
    return { values };
  });
}
