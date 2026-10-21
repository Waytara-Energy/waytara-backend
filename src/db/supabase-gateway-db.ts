import { createClient } from "@supabase/supabase-js";
import { DbError, type ActiveKey, type EquipmentInfo, type GatewayDb, type KeyInfo, type KeyKind } from "./gateway-db.js";

/**
 * The real database layer: calls the waytara.gw_* functions through Supabase's API, signed in as the backend's service user.
 * No service_role key is involved. Sign-in is lazy and automatic: the first call logs in, and a call refused for an expired or
 * invalid token logs in again once and retries.
 */

export interface RpcResult {
  data: unknown;
  error: { code?: string; message: string; status?: number } | null;
  status?: number;
}

/** The small part of the Supabase client this layer uses (so tests can stand in for it). */
export interface RpcClient {
  signIn(): Promise<void>;
  rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
}

export interface SupabaseSettings {
  url: string;
  anonKey: string;
  serviceEmail: string;
  servicePassword: string;
}

export function createRpcClient(s: SupabaseSettings): RpcClient {
  // The database types are not generated for this repository: the gw_* functions are called by name, and every result is checked below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient<any, "waytara">(s.url, s.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    db: { schema: "waytara" },
    global: { headers: { "X-Client-Info": "waytara-backend" } },
  });
  return {
    async signIn() {
      const { error } = await client.auth.signInWithPassword({ email: s.serviceEmail, password: s.servicePassword });
      if (error) throw new DbError("unavailable", "the backend could not sign in to the database");
    },
    async rpc(fn, args) {
      const r = await client.rpc(fn, args);
      return { data: r.data, error: r.error ? { code: r.error.code, message: r.error.message, status: r.status } : null, status: r.status };
    },
  };
}

const toHex = (b: Buffer) => `\\x${b.toString("hex")}`;
const fromHex = (v: unknown): Buffer => {
  if (typeof v !== "string" || !v.startsWith("\\x")) throw new DbError("invalid", "unexpected bytes from the database");
  return Buffer.from(v.slice(2), "hex");
};

function mapError(e: NonNullable<RpcResult["error"]>): DbError {
  switch (e.code) {
    case "42501":
      return new DbError("forbidden", "the database refused the call");
    case "P0002":
      return new DbError("not_found", "not found");
    case "23505":
      return new DbError("conflict", "conflict");
    case "22023":
    case "22P02":
    case "23514":
      return new DbError("invalid", "the database refused the value");
    default:
      return new DbError("unavailable", "the database is not available");
  }
}

const isAuthFailure = (e: NonNullable<RpcResult["error"]>) =>
  e.status === 401 || e.code === "PGRST301" || e.code === "PGRST303" || /jwt/i.test(e.message);

export class SupabaseGatewayDb implements GatewayDb {
  private signedIn: Promise<void> | null = null;

  constructor(private readonly client: RpcClient) {}

  private login(): Promise<void> {
    if (!this.signedIn) {
      this.signedIn = this.client.signIn().catch((error) => {
        this.signedIn = null; // try again next time
        throw error;
      });
    }
    return this.signedIn;
  }

  /** Calls one waytara.* function as the service user (signs in when needed, once more after an expired token). */
  async call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    await this.login();
    let r = await this.client.rpc(fn, args);
    if (r.error && isAuthFailure(r.error)) {
      this.signedIn = null;
      await this.login();
      r = await this.client.rpc(fn, args);
    }
    if (r.error) throw mapError(r.error);
    return r.data;
  }

  private rows(data: unknown): Record<string, unknown>[] {
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : data == null ? [] : [data as Record<string, unknown>];
  }

  async ping(): Promise<void> {
    // The all-zero ids ask a harmless question; the function refuses anyone who is not the registered service user.
    const zero = "00000000-0000-0000-0000-000000000000";
    await this.call("gw_actor_can_access_site", { p_actor: zero, p_site: zero });
  }

  async actorCanAccessSite(actor: string, site: string): Promise<boolean> {
    return (await this.call("gw_actor_can_access_site", { p_actor: actor, p_site: site })) === true;
  }

  async actorCanManageKeys(actor: string, equipment: string): Promise<boolean> {
    return (await this.call("gw_actor_can_manage_keys", { p_actor: actor, p_equipment: equipment })) === true;
  }

  async cadenceAccess(actor: string, equipment: string): Promise<"staff" | "customer" | null> {
    const v = await this.call("gw_cadence_access", { p_actor: actor, p_equipment: equipment });
    return v === "staff" || v === "customer" ? v : null;
  }

  async equipmentInfo(equipment: string): Promise<EquipmentInfo | null> {
    const row = this.rows(await this.call("gw_equipment_info", { p_equipment: equipment }))[0];
    if (!row) return null;
    return {
      equipmentId: String(row.equipment_id),
      siteId: String(row.site_id),
      label: (row.label as string | null) ?? null,
      category: (row.category as string | null) ?? null,
      technicalSpecs: (row.technical_specs as Record<string, unknown> | null) ?? null,
    };
  }

  async keyInfo(key: string): Promise<KeyInfo | null> {
    const row = this.rows(await this.call("gw_key_info", { p_key: key }))[0];
    if (!row) return null;
    return {
      keyId: String(row.key_id),
      equipmentId: String(row.equipment_id),
      kind: row.kind as KeyKind,
      label: (row.label as string | null) ?? null,
      revokedAt: (row.revoked_at as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
    };
  }

  async createKey(a: Parameters<GatewayDb["createKey"]>[0]): Promise<string> {
    const id = await this.call("gw_create_key", {
      p_equipment: a.equipmentId,
      p_kind: a.kind,
      p_label: a.label ?? null,
      p_ciphertext: toHex(a.ciphertext),
      p_fingerprint: a.fingerprint,
      p_actor: a.actor,
      p_ip: a.ip ?? null,
      p_expires: a.expiresAt ?? null,
    });
    return String(id);
  }

  async rotateKey(a: Parameters<GatewayDb["rotateKey"]>[0]): Promise<string> {
    const id = await this.call("gw_rotate_key", {
      p_key: a.keyId,
      p_ciphertext: toHex(a.ciphertext),
      p_fingerprint: a.fingerprint,
      p_actor: a.actor,
      p_ip: a.ip ?? null,
      p_grace_seconds: a.graceSeconds,
    });
    return String(id);
  }

  async revokeKey(a: Parameters<GatewayDb["revokeKey"]>[0]): Promise<boolean> {
    return (await this.call("gw_revoke_key", { p_key: a.keyId, p_actor: a.actor, p_ip: a.ip ?? null, p_reason: a.reason ?? null })) === true;
  }

  async activeKeys(equipmentId: string): Promise<ActiveKey[]> {
    return this.rows(await this.call("gw_active_keys", { p_equipment: equipmentId })).map((r) => ({
      keyId: String(r.key_id),
      kind: r.kind as KeyKind,
      ciphertext: fromHex(r.key_ciphertext),
      expiresAt: (r.expires_at as string | null) ?? null,
    }));
  }

  async touchKey(keyId: string, ip?: string | null): Promise<void> {
    await this.call("gw_touch_key", { p_key: keyId, p_ip: ip ?? null });
  }

  async recordKeyEvent(a: Parameters<GatewayDb["recordKeyEvent"]>[0]): Promise<void> {
    await this.call("gw_record_key_event", {
      p_equipment: a.equipmentId,
      p_key: a.keyId ?? null,
      p_event: a.event,
      p_actor: a.actor ?? null,
      p_ip: a.ip ?? null,
      p_detail: a.detail ?? {},
    });
  }

  async issueClaimTicket(a: Parameters<GatewayDb["issueClaimTicket"]>[0]): Promise<{ ticket: string; expiresAt: string }> {
    const row = this.rows(await this.call("gw_issue_claim_ticket", { p_equipment: a.equipmentId, p_issued_to: a.issuedTo, p_hardware_id: a.hardwareId, p_ip: a.ip ?? null }))[0];
    if (!row) throw new DbError("unavailable", "no ticket was returned");
    return { ticket: String(row.ticket), expiresAt: String(row.expires_at) };
  }

  async claimPeek(ticket: string, hardwareId: string): Promise<{ equipmentId: string } | null> {
    try {
      const row = this.rows(await this.call("gw_claim_peek", { p_ticket: ticket, p_hardware_id: hardwareId }))[0];
      return row ? { equipmentId: String(row.equipment_id) } : null;
    } catch (error) {
      if (error instanceof DbError && error.kind === "not_found") return null;
      throw error;
    }
  }

  async releaseBoard(a: Parameters<GatewayDb["releaseBoard"]>[0]): Promise<boolean> {
    return (await this.call("gw_release_board", { p_equipment: a.equipmentId, p_actor: a.actor, p_ip: a.ip ?? null })) === true;
  }

  async getPushInterval(a: Parameters<GatewayDb["getPushInterval"]>[0]): Promise<number | null> {
    const r = await this.call("gw_get_push_interval", { p_actor: a.actor, p_equipment: a.equipmentId });
    return typeof r === "number" ? r : null;
  }

  async setPushInterval(a: Parameters<GatewayDb["setPushInterval"]>[0]): Promise<{ previous: number; seconds: number }> {
    const r = (await this.call("gw_set_push_interval", { p_equipment: a.equipmentId, p_actor: a.actor, p_seconds: a.seconds, p_ip: a.ip ?? null })) as { previous?: number; seconds?: number } | null;
    return { previous: Number(r?.previous ?? 900), seconds: Number(r?.seconds ?? a.seconds) };
  }

  async claimDevice(a: Parameters<GatewayDb["claimDevice"]>[0]): Promise<{ equipmentId: string; keyId: string; issuedTo: string | null }> {
    const row = this.rows(await this.call("gw_claim_device", { p_ticket: a.ticket, p_hardware_id: a.hardwareId, p_ciphertext: toHex(a.ciphertext), p_fingerprint: a.fingerprint, p_ip: a.ip ?? null }))[0];
    if (!row) throw new DbError("unavailable", "the claim returned nothing");
    return { equipmentId: String(row.out_equipment_id), keyId: String(row.out_key_id), issuedTo: (row.out_issued_to as string | null) ?? null };
  }
}

export function createSupabaseGatewayDb(settings: SupabaseSettings): SupabaseGatewayDb {
  return new SupabaseGatewayDb(createRpcClient(settings));
}
