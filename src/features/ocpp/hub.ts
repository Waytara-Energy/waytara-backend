import type { WebSocket } from "ws";
import { OcppConnection, type ConnDeps, type ConnInfo } from "./connection.js";

/**
 * The chargers that are connected right now, one connection each (plan 13.4). A healthy live connection is never replaced by a newcomer:
 * when a second connection arrives for the same charger, the old one is pinged, and only if it does not answer within 10 seconds is it
 * replaced. Otherwise the newcomer is turned away and an event is stored for the staff to see.
 */

export class OcppHub {
  private readonly byEquipment = new Map<string, OcppConnection>();

  constructor(private readonly d: ConnDeps) {}

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
        onClosed: (c) => {
          if (this.byEquipment.get(info.equipmentId) === c) this.byEquipment.delete(info.equipmentId);
          this.d.onClosed?.(c);
        },
      },
      ws,
      info,
    );
    this.byEquipment.set(info.equipmentId, conn);
    conn.start();
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
  }
}
