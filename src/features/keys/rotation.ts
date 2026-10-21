import { KeyVault } from "../../core/key-vault.js";
import { DbError, type GatewayDb } from "../../db/gateway-db.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import type { KeyChangeBus } from "../../lib/key-events.js";
import { generateSecret } from "./generate.js";
import type { Actor } from "./service.js";

/**
 * Replacing a monitoring unit's key without locking it out (task T11 of docs/GATEWAY_V3_TASKS.md).
 *
 *   1. The hub makes the new key; the old and the new key are both valid (the database holds the rotation).
 *   2. The hub sends the new key to the unit on its working connection, sealed with the key the unit uses now: only that unit can read it.
 *   3. The unit keeps it aside and answers "rotate_staged".
 *   4. The hub answers "rotate_commit"; the unit switches to the new key and logs in again.
 *   5. The first login with the new key completes the rotation: the old key is cut.
 * If the unit does not get that far, the database cancels the rotation after its window: the new key is cut and the old one simply stays.
 * Every step after the first is driven by something the unit did (an event or a login), and the state is in the database, so a restart of the
 * hub in the middle loses nothing.
 */

/** What the hub knows about the unit's live connection. */
export interface UnitLink {
  status(equipmentId: string): { alive: boolean; caps: readonly string[] } | null;
  /** Seals a command with the key the unit uses now and publishes it. False if it could not be sent. */
  command(equipmentId: string, body: Record<string, unknown>): Promise<boolean>;
}

export type RotationState = "none" | "sent" | "staged";

export interface RotationStatus {
  state: RotationState;
  rotationId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  /** can a rotation be started now */
  canStart: boolean;
  /** why not, in plain words (null when it can) */
  reason: string | null;
}

const COMMAND_TTL_MS = 2 * 60_000;
export const ROTATE_CAP = "rotate_key";

export class RotationService {
  constructor(
    private readonly db: GatewayDb,
    private readonly vault: KeyVault,
    private readonly unit: UnitLink,
    private readonly bus?: KeyChangeBus,
    private readonly opts: { windowSeconds?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async requireManage(actor: Actor, equipmentId: string): Promise<void> {
    if (!(await this.db.actorCanManageKeys(actor.id, equipmentId))) throw notFound();
  }

  private async requireUnit(equipmentId: string): Promise<void> {
    const info = await this.db.equipmentInfo(equipmentId);
    if (!info) throw notFound();
    if (info.category === "ev_charger") throw badRequest("A charger's key is typed into the charger: replace it on the Device keys page.");
  }

  private whyNot(equipmentId: string): string | null {
    const link = this.unit.status(equipmentId);
    if (!link || !link.alive) return "The unit is not online right now. A key can only be changed while the unit is connected.";
    if (!link.caps.includes(ROTATE_CAP)) return "This unit's software cannot change its key remotely yet. Set the unit up again from the setup page instead.";
    return null;
  }

  /** The state of the unit's key change and whether one can be started now. */
  async status(actor: Actor, equipmentId: string): Promise<RotationStatus> {
    try {
      await this.requireUnit(equipmentId);
      await this.requireManage(actor, equipmentId);
      const open = await this.db.openRotation(equipmentId);
      const reason = open ? "A key change is already in progress for this unit." : this.whyNot(equipmentId);
      return {
        state: open ? open.state : "none",
        rotationId: open?.rotationId ?? null,
        startedAt: open?.startedAt ?? null,
        expiresAt: open?.expiresAt ?? null,
        canStart: reason === null,
        reason,
      };
    } catch (error) {
      this.fail(error);
    }
  }

  /** Starts a key change. The unit finishes it by itself within a few seconds. */
  async start(actor: Actor, equipmentId: string): Promise<RotationStatus> {
    let rotationId: string | null = null;
    try {
      await this.requireUnit(equipmentId);
      await this.requireManage(actor, equipmentId);
      const why = this.whyNot(equipmentId);
      if (why) throw new AppError(409, "not_possible", why);

      const keys = (await this.db.activeKeys(equipmentId)).filter((k) => k.kind === "gateway");
      if (keys.length !== 1) throw new AppError(409, "not_possible", "The unit does not have exactly one working key, so it cannot be changed this way. Set the unit up again from the setup page.");
      const current = keys[0]!;

      const secret = generateSecret("gateway");
      try {
        const begun = await this.db.beginRotation({
          oldKeyId: current.keyId,
          ciphertext: this.vault.encrypt(secret.plaintext, { equipmentId, kind: "gateway" }),
          fingerprint: KeyVault.fingerprint(secret.plaintext),
          actor: actor.id,
          ip: actor.ip,
          ...(this.opts.windowSeconds ? { windowSeconds: this.opts.windowSeconds } : {}),
        });
        rotationId = begun.rotationId;
        this.bus?.changed(equipmentId); // the login check now knows both keys
        const now = this.now();
        const sent = await this.unit.command(equipmentId, {
          id: begun.rotationId,
          type: "rotate_key",
          key_id: begun.newKeyId,
          key: secret.plaintext.toString("base64url"),
          issued_at: now,
          expires_at: now + COMMAND_TTL_MS,
        });
        if (!sent) {
          await this.db.cancelRotation(begun.rotationId, "the unit could not be reached");
          this.bus?.changed(equipmentId);
          throw new AppError(409, "not_possible", "The unit could not be reached. Nothing was changed.");
        }
      } finally {
        secret.plaintext.fill(0);
      }
      return await this.status(actor, equipmentId);
    } catch (error) {
      if (rotationId && !(error instanceof AppError)) await this.db.cancelRotation(rotationId, "an error while starting").catch(() => undefined);
      this.fail(error);
    }
  }

  /** The unit says it has the new key aside ("rotate_staged") or that it could not take it ("rotate_failed"). Never throws. */
  async onUnitEvent(equipmentId: string, type: "rotate_staged" | "rotate_failed", id: string | undefined, error: string | undefined): Promise<void> {
    if (!id) return;
    try {
      if (type === "rotate_failed") {
        if (await this.db.cancelRotation(id, error ?? "the unit could not take the new key")) this.bus?.changed(equipmentId);
        return;
      }
      if (!(await this.db.rotationStaged(id))) return; // late, repeated or already over
      const now = this.now();
      await this.unit.command(equipmentId, { id: `${id}:commit`.slice(0, 40), type: "rotate_commit", rotation: id, issued_at: now, expires_at: now + COMMAND_TTL_MS });
    } catch {
      /* the database cancels what does not finish */
    }
  }

  /** A unit logged in with this key: if it is the new key of an open rotation, the unit has switched, so the old key is cut. Never throws. */
  async onLogin(equipmentId: string, keyId: string, ip: string | null): Promise<void> {
    try {
      const rotation = await this.db.rotationForLogin(keyId);
      if (rotation && (await this.db.completeRotation(rotation, ip))) this.bus?.changed(equipmentId);
    } catch {
      /* the next login tries again */
    }
  }

  private fail(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (error instanceof DbError) {
      if (error.kind === "forbidden" || error.kind === "not_found") throw notFound();
      if (error.kind === "conflict") throw new AppError(409, "not_possible", "A key change is already in progress for this unit.");
      if (error.kind === "invalid") throw badRequest("The request was not accepted");
      throw new AppError(503, "unavailable", "The service is busy. Try again in a moment.");
    }
    throw error;
  }
}
