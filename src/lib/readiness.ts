export type ReadinessCheck = () => Promise<void>;
export type CheckResult = "ok" | "fail" | "timeout";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, CheckResult>;
}

/**
 * Dependencies register a check here (Supabase, the cadence store, the broker...). /readyz runs them all with a time limit.
 * A check signals failure by throwing; the reason is logged by whoever runs the report, never shown to the caller.
 */
export class Readiness {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  async run(timeoutMs: number, onFailure?: (name: string, error: unknown) => void): Promise<ReadinessReport> {
    const entries = [...this.checks.entries()];
    const results = await Promise.all(
      entries.map(async ([name, check]): Promise<[string, CheckResult]> => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        });
        try {
          const outcome = await Promise.race([check().then(() => "ok" as const), timeout]);
          return [name, outcome];
        } catch (error) {
          onFailure?.(name, error);
          return [name, "fail"];
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    const checks = Object.fromEntries(results);
    return { ok: results.every(([, r]) => r === "ok"), checks };
  }
}
