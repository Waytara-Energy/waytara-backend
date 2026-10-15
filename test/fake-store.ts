import { readFileSync } from "node:fs";
import type { MetricDef } from "../src/core/decode.js";
import type { EquipmentProfile, HeartbeatReport, IngestStore, SummaryWrite } from "../src/features/ingest/store.js";

const catalogue = JSON.parse(readFileSync(new URL("./fixtures/catalogue.json", import.meta.url), "utf8")) as {
  stock: { mppt_count: number };
  sweepFail: number[];
  metrics: MetricDef[];
};

/** An in-memory stand-in for the storage the data intake writes to. */
export class FakeStore implements IngestStore {
  profile: EquipmentProfile | null = {
    equipmentId: "",
    metrics: catalogue.metrics,
    mpptCount: catalogue.stock.mppt_count,
    uploadIntervalS: 900,
    unreadableRegisters: catalogue.sweepFail,
  };
  writes: SummaryWrite[] = [];
  heartbeats: HeartbeatReport[] = [];
  maps: { hash: string; body: unknown }[] = [];
  failWrites = 0;

  async loadProfile(equipmentId: string): Promise<EquipmentProfile | null> {
    return this.profile ? { ...this.profile, equipmentId } : null;
  }

  async storeMap(_equipmentId: string, hash: string, body: unknown): Promise<number> {
    const i = this.maps.findIndex((m) => m.hash === hash);
    if (i >= 0) return i + 1;
    this.maps.push({ hash, body });
    return this.maps.length;
  }

  async writeSummaries(w: SummaryWrite): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("storage down");
    }
    this.writes.push(w);
  }

  async reportHeartbeat(h: HeartbeatReport): Promise<void> {
    this.heartbeats.push(h);
  }

  allBuckets() {
    return this.writes.flatMap((w) => w.buckets);
  }
}

export const defOf = (key: string): MetricDef => {
  const d = catalogue.metrics.find((m) => m.key === key && m.direction === "read");
  if (!d) throw new Error(`no metric ${key}`);
  return d;
};
