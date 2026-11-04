import type { WebSocket } from "ws";
import { OcppConnection, type ConnDeps, type ConnInfo } from "./connection.js";
import { RetryPool } from "./retry-pool.js";

/** How long a stop asked for while a charger was out of contact stays valid. */
const QUEUED_STOP_TTL_MS = 30 * 60_000;

/**
 * The chargers that are connected right now, one connection each (plan 13.4). A healthy live connection is never replaced by a newcomer:
 * when a second connection arrives for the same charger, the old one is pinged, and only if it does not answer within 10 seconds is it
 * replaced. Otherwise the newcomer is turned away and an event is stored for the staff to see.
 */

export class OcppHub {
  private readonly byEquipment = new Map<string, OcppConnection>();
  /** transactions to stop as soon as the charger is back: charger -> transaction -> when it was asked */
  private readonly queuedStops = new Map<string, Map<number, number>>();
  /** database work that failed, kept for every charger until the database answers again */
  readonly retries: RetryPool;

  constructor(private readonly d: ConnDeps) {
    this.retries = d.retries ?? new RetryPool({ log: d.log, ...(d.retryDelaysMs ? { delaysMs: d.retryDelaysMs } : {}), ...(d.now ? { now: d.now } : {}) });
  }

  /** Remembers a stop the person asked for while the charger could not be reached; it is sent when the charger connects again (within 30 minutes). */
  queueStop(equipmentId: string, transactionId: number): void {
    const list = this.queuedStops.get(equipmentId) ?? new Map<number, number>();
    list.set(transactionId, (this.d.now ?? Date.now)());
    this.queuedStops.set(equipmentId, list);
  }

  /** The stops waiting for a charger that is now connecting (and forgets them); those older than 30 minutes are dropped. */
  private takeQueuedStops(equipmentId: string): number[] {
    const list = this.queuedStops.get(equipmentId);
    this.queuedStops.delete(equipmentId);
    if (!list) return [];
    const now = (this.d.now ?? Date.now)();
    return [...list].filter(([, at]) => now - at <= QUEUED_STOP_TTL_MS).map(([tx]) => tx);
  }

  /** Takes a new connection. Returns false (and closes it) if it is refused because the charger already has a live connection. */
  async attach(ws: WebSocket, info: ConnInfo): Promise<boolean> {
    const existing = this.byEquipment.get(info.equipmentId);
    if (existing) {
      if (await existing.alive()) {
        try {
          await this.d.store.event(info.equipmentId, null, new Date().toISOString(), "duplicate_connection", { ip: info.ip, kept: "the existing connection" });
        } catch {
          /* best effort */
        }
        ws.close(1013, "already connected");
        return false;
      }
      existing.close(1012, "replaced");
      this.byEquipment.delete(info.equipmentId);
    }
    const conn = new OcppConnection(
      {
        ...this.d,
        retries: this.retries,
        onClosed: (c) => {
          if (this.byEquipment.get(info.equipmentId) === c) this.byEquipment.delete(info.equipmentId);
          this.d.onClosed?.(c);
        },
      },
      ws,
      info,
    );
    this.byEquipment.set(info.equipmentId, conn);
    conn.start(this.takeQueuedStops(info.equipmentId));
    return true;
  }

  get(equipmentId: string): OcppConnection | undefined {
    return this.byEquipment.get(equipmentId);
  }

  isConnected(equipmentId: string): boolean {
    return this.byEquipment.has(equipmentId);
  }

  /** Disconnects a charger (its secret was revoked or replaced). */
  kick(equipmentId: string): void {
    this.byEquipment.get(equipmentId)?.close(4001, "key changed");
  }

  count(): number {
    return this.byEquipment.size;
  }

  closeAll(): void {
    for (const c of this.byEquipment.values()) c.close(1001, "server stopping");
    this.byEquipment.clear();
    this.retries.stop();
  }
}
