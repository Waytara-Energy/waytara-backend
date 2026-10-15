import type { IncomingMessage } from "node:http";
import { Aedes, type AedesPublishPacket, type AuthenticateError, type Client } from "aedes";
import { loginTokenMatches } from "../../core/mqtt-login.js";
import type { KeyChangeBus } from "../../lib/key-events.js";
import type { KeyCache } from "./key-cache.js";
import { boardMayPublish, boardMaySubscribe, isUuid, parseTopic, upTopic } from "./topics.js";

/**
 * The MQTT broker built into the backend (plan section 3.3, stage 1). Boards connect over WebSocket at /mqtt.
 *
 *   login      user name = equipment id, client id = gw-<equipment id>, password = login token derived from the equipment key
 *   publish    only wt/v1/<own id>/up/{data,hb,evt,state}
 *   subscribe  only wt/v1/<own id>/dn/{ack,cmd,map}, no wildcards
 *   will       only wt/v1/<own id>/up/state
 *
 * Every refusal looks the same to the board ("bad user name or password"); the reason is logged. A board whose key is revoked or
 * replaced is disconnected within seconds, not at the next sweep.
 */

export interface BrokerLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface BrokerOptions {
  keys: KeyCache;
  bus?: KeyChangeBus;
  log: BrokerLog;
  /** called for every message a board publishes on up/data, up/hb, up/evt and up/state */
  onUp: (equipmentId: string, name: string, payload: Buffer) => void;
  /** called when a board has logged in successfully and its connection is ready */
  onReady?: (equipmentId: string) => void;
  onDisconnect?: (equipmentId: string) => void;
  /** called (best effort) for a refused login that named a well-formed equipment id */
  onAuthFailed?: (equipmentId: string, ip: string | null) => void;
  maxPayloadBytes?: number;
  maxConnectionsPerIp?: number;
  /** failed logins from one address in a minute before it is refused outright */
  maxFailuresPerMinute?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface BoardClient extends Client {
  equipmentId?: string;
  loginToken?: string;
  ip?: string | null;
  willTopic?: string;
}

type ReqWithIp = IncomingMessage & { wtIp?: string };

export class Broker {
  private aedes!: Aedes;
  private readonly now: () => number;
  private readonly maxPayload: number;
  private readonly maxPerIp: number;
  private readonly maxFailures: number;
  private readonly perIp = new Map<string, number>();
  private readonly failures = new Map<string, { windowStart: number; count: number }>();
  private readonly byEquipment = new Map<string, Set<BoardClient>>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly o: BrokerOptions) {
    this.now = o.now ?? Date.now;
    this.maxPayload = o.maxPayloadBytes ?? 64 * 1024;
    this.maxPerIp = o.maxConnectionsPerIp ?? 20;
    this.maxFailures = o.maxFailuresPerMinute ?? 10;
  }

  async start(): Promise<void> {
    this.aedes = await Aedes.createBroker({
      id: "waytara-hub",
      connectTimeout: 10_000,
      heartbeatInterval: 15_000,
      maxClientsIdLength: 64,
      maxTopicLevels: 8,
      queueLimit: 200,
      preConnect: (client, packet, done) => this.preConnect(client as BoardClient, packet, done),
      authenticate: (client, username, password, done) => void this.authenticate(client as BoardClient, username, password, done),
      authorizePublish: (client, packet, done) => this.authorizePublish(client as BoardClient | null, packet.topic, packet.payload, done),
      authorizeSubscribe: (client, sub, done) => {
        const id = (client as BoardClient).equipmentId;
        done(null, id && boardMaySubscribe(id, sub.topic) ? { ...sub, qos: Math.min(sub.qos, 1) as 0 | 1 } : null);
      },
      authorizeForward: (client, packet) => {
        const id = (client as BoardClient).equipmentId;
        return id && parseTopic(packet.topic)?.equipmentId === id ? packet : null;
      },
    });

    this.aedes.on("clientReady", (c) => {
      const client = c as BoardClient;
      if (client.equipmentId) this.o.onReady?.(client.equipmentId);
    });
    this.aedes.on("clientDisconnect", (c) => {
      const client = c as BoardClient;
      if (!client.equipmentId) return;
      this.forget(client);
      this.o.onDisconnect?.(client.equipmentId);
    });
    this.aedes.on("clientError", (c, e) => this.o.log.warn({ client: c.id, err: e.message }, "mqtt client error"));

    // everything a board publishes on up/* comes through one in-process subscription
    await new Promise<void>((resolve) => {
      this.aedes.subscribe(
        "wt/v1/+/up/+",
        (packet: AedesPublishPacket, cb: () => void) => {
          const t = parseTopic(packet.topic);
          if (t) {
            try {
              this.o.onUp(t.equipmentId, t.name, Buffer.from(packet.payload as Buffer));
            } catch (error) {
              this.o.log.warn({ err: error instanceof Error ? error.message : String(error) }, "up message handler failed");
            }
          }
          cb();
        },
        resolve,
      );
    });

    this.o.bus?.onChanged((id) => void this.keysChanged(id));
    this.sweeper = setInterval(() => void this.sweep(), this.o.sweepIntervalMs ?? 30_000);
    this.sweeper.unref();
  }

  /** The WebSocket route hands each upgraded connection here. */
  handle(stream: Parameters<Aedes["handle"]>[0], req: IncomingMessage, ip: string | null): void {
    (req as ReqWithIp).wtIp = ip ?? undefined;
    this.aedes.handle(stream, req);
  }

  /** Publishes to a board (a downlink topic), for example the acknowledgement or the register map. */
  publish(equipmentId: string, topic: string, payload: Buffer, opts: { retain?: boolean } = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.aedes.publish({ cmd: "publish", topic, payload, qos: 1, retain: opts.retain ?? false, dup: false }, (e) => (e ? reject(e) : resolve()));
    });
  }

  isConnected(equipmentId: string): boolean {
    return (this.byEquipment.get(equipmentId)?.size ?? 0) > 0;
  }

  connectedEquipment(): string[] {
    return [...this.byEquipment.keys()];
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await new Promise<void>((resolve) => this.aedes.close(() => resolve()));
  }

  // ---- login

  private ipOf(client: BoardClient): string | null {
    return ((client.req as ReqWithIp | undefined)?.wtIp as string | undefined) ?? client.req?.socket.remoteAddress ?? null;
  }

  private preConnect(client: BoardClient, packet: { will?: { topic: string }; clientId: string; protocolVersion?: number }, done: (e: Error | null, ok: boolean) => void): void {
    const ip = this.ipOf(client);
    if (ip) {
      const f = this.failures.get(ip);
      if (f && this.now() - f.windowStart < 60_000 && f.count >= this.maxFailures) return done(null, false);
      if ((this.perIp.get(ip) ?? 0) >= this.maxPerIp) return done(null, false);
    }
    if (packet.will) {
      // the last-will may only be the board's own presence topic; checked again for the right id after login
      const t = parseTopic(packet.will.topic);
      if (!t || t.dir !== "up" || t.name !== "state") return done(null, false);
      client.willTopic = packet.will.topic;
    }
    done(null, true);
  }

  private fail(client: BoardClient, equipmentId: string | null, why: string, done: (e: AuthenticateError | null, ok: boolean | null) => void): void {
    const ip = this.ipOf(client);
    if (ip) {
      const f = this.failures.get(ip);
      if (!f || this.now() - f.windowStart >= 60_000) this.failures.set(ip, { windowStart: this.now(), count: 1 });
      else f.count++;
    }
    this.o.log.warn({ why, equipmentId, ip }, "mqtt login refused");
    if (equipmentId) this.o.onAuthFailed?.(equipmentId, ip);
    done(Object.assign(new Error("bad user name or password"), { returnCode: 4 }) as AuthenticateError, false);
  }

  private async authenticate(client: BoardClient, username: string | undefined, password: Buffer | undefined, done: (e: AuthenticateError | null, ok: boolean | null) => void): Promise<void> {
    try {
      const id = username?.toLowerCase();
      if (!id || !isUuid(id)) return this.fail(client, null, "malformed user name", done);
      if (client.id !== `gw-${id}`) return this.fail(client, id, "client id does not match", done);
      const keys = await this.o.keys.get(id);
      const match = keys.find((k) => loginTokenMatches(k.loginToken, password));
      if (!match) return this.fail(client, id, keys.length === 0 ? "no active key" : "wrong token", done);

      if (client.willTopic !== undefined && client.willTopic !== upTopic(id, "state")) return this.fail(client, id, "last-will on another topic", done);

      client.equipmentId = id;
      client.loginToken = match.loginToken;
      client.ip = this.ipOf(client);
      this.remember(client);
      done(null, true);
    } catch (error) {
      this.o.log.warn({ err: error instanceof Error ? error.message : String(error) }, "mqtt login check failed");
      done(Object.assign(new Error("server unavailable"), { returnCode: 3 }) as AuthenticateError, false);
    }
  }

  private authorizePublish(client: BoardClient | null, topic: string, payload: unknown, done: (e?: Error | null) => void): void {
    if (client === null) return done(); // the broker's own messages (acknowledgements, maps)
    const id = client.equipmentId;
    if (!id || !boardMayPublish(id, topic)) {
      this.o.log.warn({ equipmentId: id, topic }, "mqtt publish refused");
      return done(new Error("not allowed"));
    }
    const size = Buffer.isBuffer(payload) ? payload.length : 0;
    if (size > this.maxPayload) {
      this.o.log.warn({ equipmentId: id, size }, "mqtt message too large");
      return done(new Error("too large"));
    }
    done();
  }

  // ---- bookkeeping

  private remember(client: BoardClient): void {
    const id = client.equipmentId!;
    const set = this.byEquipment.get(id) ?? new Set<BoardClient>();
    // one live connection per board: a new login (the same key) replaces the old connection
    for (const old of set) if (old !== client) old.close();
    set.add(client);
    this.byEquipment.set(id, set);
    const ip = client.ip;
    if (ip) this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
  }

  private forget(client: BoardClient): void {
    const id = client.equipmentId;
    if (!id) return;
    const set = this.byEquipment.get(id);
    if (set?.delete(client) && set.size === 0) this.byEquipment.delete(id);
    const ip = client.ip;
    if (ip) {
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
    }
  }

  /** A key was made, rotated, revoked or replaced: forget the cache and drop any connection whose token no longer works. */
  private async keysChanged(equipmentId: string): Promise<void> {
    this.o.keys.invalidate(equipmentId);
    await this.dropStale(equipmentId);
  }

  private async dropStale(equipmentId: string): Promise<void> {
    const clients = this.byEquipment.get(equipmentId);
    if (!clients || clients.size === 0) return;
    let keys;
    try {
      keys = await this.o.keys.get(equipmentId);
    } catch {
      return; // cannot tell: keep the connection, try again at the next sweep
    }
    for (const c of [...clients]) {
      if (!keys.some((k) => k.loginToken === c.loginToken)) {
        this.o.log.info({ equipmentId }, "mqtt connection closed: its key is no longer valid");
        c.close();
      }
    }
  }

  private async sweep(): Promise<void> {
    for (const id of [...this.byEquipment.keys()]) {
      this.o.keys.invalidate(id);
      await this.dropStale(id);
    }
    for (const [ip, f] of this.failures) if (this.now() - f.windowStart >= 60_000) this.failures.delete(ip);
  }

  /** The presence topic a board's last-will uses, for tests and diagnostics. */
  static presenceTopic(equipmentId: string): string {
    return upTopic(equipmentId, "state");
  }
}
