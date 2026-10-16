import { CLAIM_ALG, EciesError, eciesEncrypt, isValidPublicKey } from "../../core/ecies.js";
import { KeyVault } from "../../core/key-vault.js";
import { DbError, type GatewayDb, type KeyKind } from "../../db/gateway-db.js";
import type { KeyChangeBus } from "../../lib/key-events.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { generateSecret } from "./generate.js";

/**
 * Key and claim logic. Nothing here knows about HTTP.
 *
 * Who may do what (the database decides, this code asks):
 *   create, rotate, revoke a key by hand   admin, or staff assigned to the site (never a customer)
 *   get a claim ticket for a board         anyone who can access the site: the owner, assigned staff, an admin
 *   claim (the board itself)               whoever holds a valid ticket for that board
 * A caller who is not allowed gets "not found", the same as for something that does not exist, so ids cannot be probed.
 */

export interface Actor {
  id: string;
  ip: string | null;
}

export interface IssuedSecret {
  keyId: string;
  equipmentId: string;
  kind: KeyKind;
  fingerprint: string;
  /** shown once, never stored in the clear */
  secret: string;
  createdAt: string;
}

const gatewayCategories = (c: string | null) => c !== "ev_charger";

function mapDb(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof DbError) {
    if (error.kind === "forbidden" || error.kind === "not_found") throw notFound();
    if (error.kind === "conflict") throw new AppError(409, "conflict", "That conflicts with the current state");
    if (error.kind === "invalid") throw badRequest("The request was not accepted");
    throw new AppError(503, "unavailable", "The service is busy. Try again in a moment.");
  }
  throw error;
}

export class KeyService {
  constructor(
    private readonly db: GatewayDb,
    private readonly vault: KeyVault,
    private readonly now: () => Date = () => new Date(),
    private readonly bus?: KeyChangeBus,
  ) {}

  private async requireManage(actor: Actor, equipmentId: string): Promise<void> {
    if (!(await this.db.actorCanManageKeys(actor.id, equipmentId))) throw notFound();
  }

  async createKey(actor: Actor, equipmentId: string, kind: KeyKind, label: string | null): Promise<IssuedSecret> {
    try {
      const info = await this.db.equipmentInfo(equipmentId);
      if (!info) throw notFound();
      await this.requireManage(actor, equipmentId);
      const isCharger = info.category === "ev_charger";
      if ((kind === "charger") !== isCharger) throw badRequest(isCharger ? "An EV charger uses a charger key" : "This equipment uses a gateway key");

      const s = generateSecret(kind);
      const fingerprint = KeyVault.fingerprint(s.plaintext);
      const keyId = await this.db.createKey({
        equipmentId,
        kind,
        label,
        ciphertext: this.vault.encrypt(s.plaintext, { equipmentId, kind }),
        fingerprint,
        actor: actor.id,
        ip: actor.ip,
      });
      this.bus?.changed(equipmentId);
      return { keyId, equipmentId, kind, fingerprint, secret: s.display, createdAt: this.now().toISOString() };
    } catch (error) {
      mapDb(error);
    }
  }

  async rotateKey(actor: Actor, keyId: string, graceSeconds: number): Promise<IssuedSecret> {
    try {
      const info = await this.db.keyInfo(keyId);
      if (!info || info.revokedAt) throw notFound();
      await this.requireManage(actor, info.equipmentId);
      const s = generateSecret(info.kind);
      const fingerprint = KeyVault.fingerprint(s.plaintext);
      const newId = await this.db.rotateKey({
        keyId,
        ciphertext: this.vault.encrypt(s.plaintext, { equipmentId: info.equipmentId, kind: info.kind }),
        fingerprint,
        actor: actor.id,
        ip: actor.ip,
        graceSeconds,
      });
      this.bus?.changed(info.equipmentId);
      return { keyId: newId, equipmentId: info.equipmentId, kind: info.kind, fingerprint, secret: s.display, createdAt: this.now().toISOString() };
    } catch (error) {
      mapDb(error);
    }
  }

  async revokeKey(actor: Actor, keyId: string, reason: string | null): Promise<{ revoked: boolean }> {
    try {
      const info = await this.db.keyInfo(keyId);
      if (!info) throw notFound();
      await this.requireManage(actor, info.equipmentId);
      const revoked = await this.db.revokeKey({ keyId, actor: actor.id, ip: actor.ip, reason });
      if (revoked) this.bus?.changed(info.equipmentId);
      return { revoked };
    } catch (error) {
      mapDb(error);
    }
  }

  /**
   * Unlinks the monitoring unit from this equipment (and revokes its key) so the unit can be set up for another one. Whoever may make or revoke
   * the equipment's keys may do it. `released` is false when no unit was linked.
   */
  async releaseBoard(actor: Actor, equipmentId: string): Promise<{ released: boolean }> {
    try {
      const info = await this.db.equipmentInfo(equipmentId);
      if (!info) throw notFound();
      if (!gatewayCategories(info.category)) throw badRequest("A charger has no monitoring unit to release");
      await this.requireManage(actor, equipmentId);
      const released = await this.db.releaseBoard({ equipmentId, actor: actor.id, ip: actor.ip });
      if (released) this.bus?.changed(equipmentId); // the unit's connection is closed within seconds
      return { released };
    } catch (error) {
      mapDb(error);
    }
  }

  /** A ticket the setup page hands to the board. Whoever may access the site may ask for one. */
  async issueClaimTicket(actor: Actor, equipmentId: string, hardwareId: string): Promise<{ ticket: string; expiresAt: string }> {
    try {
      const info = await this.db.equipmentInfo(equipmentId);
      if (!info) throw notFound();
      if (!gatewayCategories(info.category)) throw badRequest("A charger is not set up with a ticket");
      if (!(await this.db.actorCanAccessSite(actor.id, info.siteId))) throw notFound();
      return await this.db.issueClaimTicket({ equipmentId, issuedTo: actor.id, hardwareId, ip: actor.ip });
    } catch (error) {
      mapDb(error);
    }
  }

  /**
   * The board collects its key. The caller is not signed in: the ticket is the proof. Every failure looks the same from outside.
   * The response carries the key only inside a box that the board's own public key opens.
   */
  async claim(input: { ticket: string; hardwareId: string; boardPublicKey: Buffer; ip: string | null }): Promise<{
    equipmentId: string;
    keyId: string;
    alg: string;
    serverPublicKey: Buffer;
    nonce: Buffer;
    ciphertext: Buffer;
  }> {
    const refuse = () => new AppError(404, "not_found", "Invalid or expired ticket");
    try {
      if (!isValidPublicKey(input.boardPublicKey)) throw badRequest("The board key is not valid");
      const peek = await this.db.claimPeek(input.ticket, input.hardwareId);
      if (!peek) throw refuse();
      const { equipmentId } = peek;

      const s = generateSecret("gateway");
      const box = eciesEncrypt(input.boardPublicKey, s.plaintext, `${equipmentId}|${input.hardwareId}`);
      const claimed = await this.db
        .claimDevice({
          ticket: input.ticket,
          hardwareId: input.hardwareId,
          ciphertext: this.vault.encrypt(s.plaintext, { equipmentId, kind: "gateway" }),
          fingerprint: KeyVault.fingerprint(s.plaintext),
          ip: input.ip,
        })
        .catch((error: unknown) => {
          if (error instanceof DbError && error.kind === "not_found") throw refuse();
          throw error;
        });
      this.bus?.changed(claimed.equipmentId);
      return { equipmentId: claimed.equipmentId, keyId: claimed.keyId, alg: CLAIM_ALG, serverPublicKey: box.ephemeralPublicKey, nonce: box.nonce, ciphertext: box.ciphertext };
    } catch (error) {
      if (error instanceof EciesError) throw badRequest("The board key is not valid");
      mapDb(error);
    }
  }
}
