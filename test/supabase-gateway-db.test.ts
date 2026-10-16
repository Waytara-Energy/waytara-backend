import { describe, expect, it } from "vitest";
import { DbError } from "../src/db/gateway-db.js";
import { SupabaseGatewayDb, type RpcClient, type RpcResult } from "../src/db/supabase-gateway-db.js";

const UUID = "bc3e9b3e-d307-4686-b34c-576674f9a79b";
const EQ = "b4c30eb8-fba4-4487-aa7a-3c1b089e36e2";

function client(replies: ((fn: string, args: Record<string, unknown>) => RpcResult)[]) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let signIns = 0;
  let i = 0;
  const c: RpcClient = {
    async signIn() {
      signIns++;
    },
    async rpc(fn, args) {
      calls.push({ fn, args });
      return replies[Math.min(i++, replies.length - 1)]!(fn, args);
    },
  };
  return { c, calls, signIns: () => signIns };
}
const ok = (data: unknown) => () => ({ data, error: null });
const fail = (code: string, status = 400, message = "x") => () => ({ data: null, error: { code, message, status } });

describe("SupabaseGatewayDb: what is sent", () => {
  it("signs in once, lazily, and sends the exact parameter names the functions expect", async () => {
    const { c, calls, signIns } = client([ok(true), ok(false)]);
    const db = new SupabaseGatewayDb(c);
    expect(signIns()).toBe(0);
    expect(await db.actorCanAccessSite(UUID, EQ)).toBe(true);
    expect(await db.actorCanManageKeys(UUID, EQ)).toBe(false);
    expect(signIns()).toBe(1);
    expect(calls).toEqual([
      { fn: "gw_actor_can_access_site", args: { p_actor: UUID, p_site: EQ } },
      { fn: "gw_actor_can_manage_keys", args: { p_actor: UUID, p_equipment: EQ } },
    ]);
  });

  it("sends bytes as a Postgres hex string and returns the id", async () => {
    const { c, calls } = client([ok("11111111-1111-1111-1111-111111111111")]);
    const id = await new SupabaseGatewayDb(c).createKey({ equipmentId: EQ, kind: "gateway", label: "board", ciphertext: Buffer.from([0xde, 0xad, 0xbe, 0xef]), fingerprint: "abcdef012345", actor: UUID, ip: "10.0.0.1" });
    expect(id).toBe("11111111-1111-1111-1111-111111111111");
    expect(calls[0]).toEqual({
      fn: "gw_create_key",
      args: { p_equipment: EQ, p_kind: "gateway", p_label: "board", p_ciphertext: "\\xdeadbeef", p_fingerprint: "abcdef012345", p_actor: UUID, p_ip: "10.0.0.1", p_expires: null },
    });
  });

  it("maps the release call, with the person who asked and no address when there is none", async () => {
    const { c, calls } = client([ok(true), ok(false)]);
    const db = new SupabaseGatewayDb(c);
    expect(await db.releaseBoard({ equipmentId: EQ, actor: UUID, ip: "203.0.113.9" })).toBe(true);
    expect(await db.releaseBoard({ equipmentId: EQ, actor: UUID })).toBe(false);
    expect(calls[0]).toEqual({ fn: "gw_release_board", args: { p_equipment: EQ, p_actor: UUID, p_ip: "203.0.113.9" } });
    expect(calls[1]!.args).toEqual({ p_equipment: EQ, p_actor: UUID, p_ip: null });
  });

  it("maps the rotate, revoke, touch, event and ticket calls", async () => {
    const { c, calls } = client([ok("k2"), ok(true), ok(null), ok(null), ok([{ ticket: "t1", expires_at: "2026-10-15T07:00:00Z" }]), ok([{ equipment_id: EQ }]), ok([{ out_equipment_id: EQ, out_key_id: "k3", out_issued_to: UUID }])]);
    const db = new SupabaseGatewayDb(c);
    await db.rotateKey({ keyId: "k1", ciphertext: Buffer.alloc(40), fingerprint: "f".repeat(12), actor: UUID, graceSeconds: 60 });
    await db.revokeKey({ keyId: "k1", actor: UUID, reason: "lost" });
    await db.touchKey("k1", "1.2.3.4");
    await db.recordKeyEvent({ equipmentId: EQ, event: "auth_failed", detail: { why: "bad key" } });
    expect(await db.issueClaimTicket({ equipmentId: EQ, issuedTo: UUID, hardwareId: "AABBCCDDEEFF" })).toEqual({ ticket: "t1", expiresAt: "2026-10-15T07:00:00Z" });
    expect(await db.claimPeek("t1", "AABBCCDDEEFF")).toEqual({ equipmentId: EQ });
    expect(await db.claimDevice({ ticket: "t1", hardwareId: "AABBCCDDEEFF", ciphertext: Buffer.alloc(40), fingerprint: "f".repeat(12) })).toEqual({ equipmentId: EQ, keyId: "k3", issuedTo: UUID });
    expect(calls.map((x) => x.fn)).toEqual(["gw_rotate_key", "gw_revoke_key", "gw_touch_key", "gw_record_key_event", "gw_issue_claim_ticket", "gw_claim_peek", "gw_claim_device"]);
    expect(calls[0]!.args).toMatchObject({ p_key: "k1", p_grace_seconds: 60 });
    expect(calls[3]!.args).toMatchObject({ p_event: "auth_failed", p_detail: { why: "bad key" }, p_key: null });
  });
});

describe("SupabaseGatewayDb: what comes back", () => {
  it("reads equipment info, key info and active keys", async () => {
    const { c } = client([
      ok([{ equipment_id: EQ, site_id: "s1", label: "Office", category: "solar_inverter", technical_specs: { mppt_count: 2 } }]),
      ok([]),
      ok([{ key_id: "k1", equipment_id: EQ, kind: "gateway", label: null, revoked_at: null, expires_at: null }]),
      ok([{ key_id: "k1", kind: "gateway", key_ciphertext: "\\x0102030405", expires_at: null }]),
    ]);
    const db = new SupabaseGatewayDb(c);
    expect(await db.equipmentInfo(EQ)).toEqual({ equipmentId: EQ, siteId: "s1", label: "Office", category: "solar_inverter", technicalSpecs: { mppt_count: 2 } });
    expect(await db.equipmentInfo("x")).toBeNull();
    expect(await db.keyInfo("k1")).toMatchObject({ keyId: "k1", equipmentId: EQ, kind: "gateway", revokedAt: null });
    const keys = await db.activeKeys(EQ);
    expect(keys[0]!.ciphertext).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  it("treats a missing ticket as null, not as an error", async () => {
    const { c } = client([fail("P0002")]);
    expect(await new SupabaseGatewayDb(c).claimPeek("t", "AABBCCDDEEFF")).toBeNull();
  });
});

describe("SupabaseGatewayDb: when something goes wrong", () => {
  const kindOf = async (reply: () => RpcResult) => {
    try {
      await new SupabaseGatewayDb(client([reply]).c).actorCanAccessSite(UUID, EQ);
      return "no error";
    } catch (e) {
      return e instanceof DbError ? e.kind : "other";
    }
  };

  it("names the cause in terms the callers can act on", async () => {
    expect(await kindOf(fail("42501"))).toBe("forbidden");
    expect(await kindOf(fail("P0002"))).toBe("not_found");
    expect(await kindOf(fail("23505"))).toBe("conflict");
    expect(await kindOf(fail("22023"))).toBe("invalid");
    expect(await kindOf(fail("XX000", 500, "connection to server lost"))).toBe("unavailable");
  });

  it("never passes the database's message on", async () => {
    try {
      await new SupabaseGatewayDb(client([fail("XX000", 500, "password authentication failed for user postgres")]).c).ping();
    } catch (e) {
      expect((e as Error).message).not.toContain("postgres");
    }
  });

  it("signs in again once when the token was refused, then retries", async () => {
    const { c, calls, signIns } = client([fail("PGRST301", 401, "JWT expired"), ok(true)]);
    expect(await new SupabaseGatewayDb(c).actorCanAccessSite(UUID, EQ)).toBe(true);
    expect(signIns()).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("gives up after one retry", async () => {
    const { c, calls } = client([fail("PGRST301", 401, "JWT expired")]);
    await expect(new SupabaseGatewayDb(c).ping()).rejects.toBeInstanceOf(DbError);
    expect(calls).toHaveLength(2);
  });

  it("reports a failed sign-in as unavailable and tries again on the next call", async () => {
    let attempts = 0;
    const c: RpcClient = {
      async signIn() {
        attempts++;
        if (attempts === 1) throw new DbError("unavailable", "no");
      },
      async rpc() {
        return { data: true, error: null };
      },
    };
    const db = new SupabaseGatewayDb(c);
    await expect(db.ping()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(db.ping()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
