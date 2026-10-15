import { EventEmitter } from "node:events";

/**
 * Tells the rest of the backend that an equipment's keys changed (made, rotated, revoked, a board claimed), so the broker can forget
 * what it cached and disconnect a board whose key no longer works, within seconds rather than at the next sweep.
 */
export class KeyChangeBus extends EventEmitter {
  changed(equipmentId: string): void {
    this.emit("changed", equipmentId);
  }

  onChanged(listener: (equipmentId: string) => void): void {
    this.on("changed", listener);
  }
}
