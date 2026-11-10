import { createHash } from "node:crypto";
import type { PgPool } from "../persistence/pg-pool.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { claimRows } from "../tenants/claim.ts";
import { sleep } from "../util/async.ts";
import { swallow } from "../util/errors.ts";
import type { Run, RunStore, SessionWatch } from "./run-store.ts";
import { isTerminal, RUN_WAIT_FALLBACK_MS } from "./run-store.ts";

export const NOTIFY_SESSION_AVAILABLE =
  "pg_notify('qm_run_available', to_json(encode(sha256(convert_to(session_id, 'UTF8')), 'hex'))::text)";

function sessionAvailabilityKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function createRunWatch(
  connectionString: string,
  pg: PgPool,
  getRun: (id: string) => Promise<Run | null>,
): Pick<RunStore, "subscribeAvailable" | "watchSession" | "waitFor"> & { close(): Promise<void> } {
  const available = createPostgresNotifyBus<string>(connectionString, "qm_run_available", "run availability");

  const availabilityListeners = new Map<() => void, number>();
  let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let availabilityProbe: Promise<void> | null = null;
  let availabilityClosed = false;

  function watchAvailability(): void {
    if (availabilityClosed || availabilityListeners.size === 0 || availabilityTimer || availabilityProbe) return;
    availabilityTimer = setTimeout(
      () => {
        availabilityTimer = undefined;
        availabilityProbe = claimRows(pg, "claim_available_runs", [Date.now()])
          .then((rows) => {
            if (rows.length) for (const listener of availabilityListeners.keys()) listener();
          })
          .catch((error: unknown) => swallow("run availability probe", error))
          .finally(() => {
            availabilityProbe = null;
            watchAvailability();
          });
      },
      Math.min(...availabilityListeners.values()),
    );
    availabilityTimer.unref();
  }

  function watchSession(sessionId: string): SessionWatch {
    let changed = true;
    let wake: (() => void) | undefined;
    const note = (): void => {
      changed = true;
      wake?.();
    };
    const key = sessionAvailabilityKey(sessionId);
    const off = available.subscribe((session) => (session === key ? note() : undefined), { onResync: note });
    return {
      changed(timeoutMs, signal) {
        return new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            wake = undefined;
            changed = false;
            resolve();
          };
          const timer = setTimeout(done, changed || signal?.aborted ? 0 : timeoutMs);
          signal?.addEventListener("abort", done);
          wake = done;
        });
      },
      close: off,
    };
  }

  return {
    subscribeAvailable(listener, options) {
      availabilityListeners.set(listener, options?.pollMs ?? 50);
      clearTimeout(availabilityTimer);
      availabilityTimer = undefined;
      const off = available.subscribe(listener, options);
      watchAvailability();
      return () => {
        off();
        availabilityListeners.delete(listener);
        if (availabilityListeners.size === 0) {
          clearTimeout(availabilityTimer);
          availabilityTimer = undefined;
        }
      };
    },
    watchSession,
    async waitFor(runId, timeoutMs = 60_000): Promise<Run> {
      const deadline = Date.now() + timeoutMs;
      let watch: SessionWatch | undefined;
      try {
        for (;;) {
          const run = await getRun(runId);
          if (run && isTerminal(run.status)) return run;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
          if (run) watch ??= watchSession(run.sessionId);
          const wait = Math.min(RUN_WAIT_FALLBACK_MS, remaining);
          await (watch ? watch.changed(wait) : sleep(wait));
        }
      } finally {
        watch?.close();
      }
    },
    async close() {
      availabilityClosed = true;
      clearTimeout(availabilityTimer);
      availabilityListeners.clear();
      await availabilityProbe;
      await available.close?.();
    },
  };
}
