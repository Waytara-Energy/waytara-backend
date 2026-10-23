import { EventEmitter } from "node:events";
import { z } from "zod";
import type { OcppHub } from "./hub.js";
import type { EvStore, GatewayCharger } from "./store.js";

/**
 * A charger that is connected to a monitoring unit's own Wi-Fi (not to the internet) reaches the hub through the unit: the unit keeps the
 * charger's WebSocket on its side and passes every message up and down as sealed MQTT messages (up/ocpp and dn/ocpp), word for word.
 * Here each such charger becomes a "virtual socket" that looks like a WebSocket to the OCPP server, so everything the server already does
 * (meter values, sessions, commands, the dashboard) works the same whether a charger connects directly or through a unit.
 *
 *   unit -> hub   {t:"open", cp}   a charger connected (cp = the name in its address, ws://<unit>/ocpp/<cp>)
 *                 {t:"frame", cp, f}   a message from the charger, as text
 *                 {t:"close", cp}  the charger went away
 *   hub -> unit   {t:"frame", cp, f}   a message for the charger
 *                 {t:"close", cp, why}   the hub does not know this charger or ends the connection
 *
 * Which equipment a charger name belongs to is the unit's own list of chargers (gateway_chargers): a unit can only speak for chargers that
 * were added to it. A unit that stops checking in takes its chargers down with it.
 */

export const upBody = z.object({
  t: z.enum(["open", "frame", "close"]),
  cp: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  f: z.string().max(16_000).optional(),
});
export type OcppUp = z.infer<typeof upBody>;

export interface BridgeDeps {
  hub: Pick<OcppHub, "attach" | "get">;
  store: Pick<EvStore, "gatewayCharger" | "gatewayChargers" | "heartbeat">;
  /** seals and publishes a message for a unit; false when it could not be sent */
  send: (gatewayId: string, body: Record<string, unknown>) => Promise<boolean>;
  /** has this unit checked in lately? */
  alive: (gatewayId: string) => boolean;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

/** Enough of a WebSocket for OcppConnection (see connection.ts: on, off, once, send, ping, terminate, close, readyState). */
export class VirtualSocket extends EventEmitter {
  readyState = 1;
  constructor(
    private readonly out: (raw: string) => void,
    private readonly end: (why: string) => void,
  ) {
    super();
  }
  send(raw: string): void {
    if (this.readyState === 1) this.out(raw);
  }
  /** The unit is alive while it keeps checking in, so a ping is answered at once; a dead unit closes every socket (see tick). */
  ping(): void {
    setImmediate(() => this.emit("pong"));
  }
  close(_code?: number, reason?: string): void {
    this.shutdown(reason ?? "closed", true);
  }
  terminate(): void {
    this.shutdown("terminated", true);
  }
  /** `tell`: also tell the unit to drop the charger. */
  shutdown(why: string, tell: boolean): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    if (tell) this.end(why);
    this.emit("close");
  }
}

export class OcppBridge {
  private readonly sockets = new Map<string, VirtualSocket>();
  private timer: NodeJS.Timeout | undefined;
  private readonly lists = new Map<string, { at: number; list: GatewayCharger[] }>();

  constructor(private readonly d: BridgeDeps) {}

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sockets.values()) s.shutdown("stopping", false);
    this.sockets.clear();
  }

  private key = (gatewayId: string, cp: string) => `${gatewayId}|${cp}`;

  /** A message from a unit's charger side. Never throws. */
  async onUp(gatewayId: string, raw: unknown): Promise<void> {
    const parsed = upBody.safeParse(raw);
    if (!parsed.success) {
      this.d.log.warn({ equipmentId: gatewayId }, "ocpp bridge message has the wrong shape");
      return;
    }
    const m = parsed.data;
    const k = this.key(gatewayId, m.cp);
    try {
      if (m.t === "open") {
        const charger = await this.d.store.gatewayCharger(gatewayId, m.cp);
        if (!charger) {
          this.d.log.warn({ equipmentId: gatewayId, charger: m.cp }, "a charger that was not added to this unit tried to connect");
          await this.d.send(gatewayId, { t: "close", cp: m.cp, why: "unknown charger" });
          return;
        }
        this.sockets.get(k)?.shutdown("replaced", false);
        const sock = new VirtualSocket(
          (f) => void this.d.send(gatewayId, { t: "frame", cp: m.cp, f }),
          (why) => void this.d.send(gatewayId, { t: "close", cp: m.cp, why }),
        );
        sock.once("close", () => {
          if (this.sockets.get(k) === sock) this.sockets.delete(k);
        });
        this.sockets.set(k, sock);
        const ok = await this.d.hub.attach(sock as never, { equipmentId: charger, chargePointId: m.cp, keyId: "unit", ip: null });
        if (!ok) sock.shutdown("refused", true);
      } else if (m.t === "frame") {
        const sock = this.sockets.get(k);
        if (!sock || m.f === undefined) return;
        sock.emit("message", Buffer.from(m.f, "utf8"));
      } else {
        this.sockets.get(k)?.shutdown("charger left", false);
      }
    } catch (error) {
      this.d.log.warn({ equipmentId: gatewayId, charger: m.cp, err: error instanceof Error ? error.message : String(error) }, "ocpp bridge message failed");
    }
  }

  /**
   * The unit's own check-in (every 10 seconds) is the pulse of everything behind it: each charger added to the unit gets the same check-in, at the
   * same rhythm, as the inverter. It is "online" while its connection through the unit is open and it spoke in the last minute; otherwise the unit
   * is alive but the charger is not answering, which the status logic treats exactly like an inverter that does not answer its unit.
   */
  async onUnitHeartbeat(gatewayId: string): Promise<void> {
    try {
      const cached = this.lists.get(gatewayId);
      let list = cached?.list ?? [];
      if (!cached || Date.now() - cached.at > 60_000) {
        list = await this.d.store.gatewayChargers(gatewayId);
        this.lists.set(gatewayId, { at: Date.now(), list });
      }
      for (const c of list) {
        const conn = this.d.hub.get(c.equipmentId);
        const online = !!conn && this.sockets.has(this.key(gatewayId, c.chargePointId)) && Date.now() - conn.lastMessageAt < 60_000;
        await this.d.store.heartbeat(c.equipmentId, null, { heartbeatS: 10, online }).catch((error: unknown) => this.d.log.warn({ equipmentId: c.equipmentId, err: error instanceof Error ? error.message : String(error) }, "could not store a charger heartbeat"));
      }
    } catch (error) {
      this.d.log.warn({ equipmentId: gatewayId, err: error instanceof Error ? error.message : String(error) }, "could not list the unit's chargers");
    }
  }

  /** A unit that has gone quiet takes its chargers with it. */
  tick(): void {
    for (const [k, sock] of this.sockets) {
      const gatewayId = k.slice(0, k.indexOf("|"));
      if (!this.d.alive(gatewayId)) sock.shutdown("unit offline", false);
    }
  }

  /** The chargers that are connected through this unit right now. */
  connected(gatewayId: string): string[] {
    return [...this.sockets.keys()].filter((k) => k.startsWith(`${gatewayId}|`)).map((k) => k.slice(gatewayId.length + 1));
  }
}
