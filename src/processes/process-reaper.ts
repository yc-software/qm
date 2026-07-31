import type { ProcessRecord, ProcessRegistry } from "./process-registry.ts";
import { createSweeper } from "../util/sweeper.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { awaitProcessExit } from "../sandbox/await-process-exit.ts";
import { processIsGone } from "../sandbox/process-poll.ts";
import type { ProcessSandbox } from "../sandbox/sandbox.ts";
import { errMessage } from "../util/errors.ts";

const PROCESS_REAPER_LEASE_KEY = "processes:reaper";

export interface ReaperKillHookOptions {
  termGraceMs?: number;
  killGraceMs?: number;
}

export function createReaperKillHook(
  sandbox: ProcessSandbox,
  opts?: ReaperKillHookOptions,
): (rec: ProcessRecord) => Promise<void> {
  const termGraceMs = opts?.termGraceMs ?? 5_000;
  const killGraceMs = opts?.killGraceMs ?? 2_000;
  return async (rec) => {
    const handle = await sandbox.provision([{ scopeId: rec.scopeId, mode: "rw", mountPath: "" }]);
    try {
      await sandbox.signalProcess(handle, rec.processId, "TERM");
      let status = await awaitProcessExit(sandbox, handle, rec.processId, termGraceMs);
      if (status.state !== "exited") {
        await sandbox.signalProcess(handle, rec.processId, "KILL");
        status = await awaitProcessExit(sandbox, handle, rec.processId, killGraceMs);
      }
      if (status.state !== "exited") throw new Error(`process survived TERM+KILL: ${rec.processId}`);
    } catch (e) {
      if (!processIsGone(e)) throw e;
    } finally {
      await sandbox.teardown(handle, { keepWarm: true });
    }
  };
}

export interface ProcessReaper {
  start(): void;
  stop(): void;
  sweep(): Promise<{ reaped: number }>;
}

export interface ProcessReaperOptions {
  intervalMs: number;
  kill?: (rec: ProcessRecord) => Promise<void>;
  onReaped?: (rec: ProcessRecord) => Promise<void>;
  leaderLease?: LeaderLease;
}

export function createProcessReaper(registry: ProcessRegistry, opts: ProcessReaperOptions): ProcessReaper {
  const leaderLease = opts.leaderLease ?? createNoopLeaderLease();
  async function sweep(): Promise<{ reaped: number }> {
    const expired = await registry.listExpired();
    let reaped = 0;
    for (const rec of expired) {
      if (opts.kill) {
        try {
          await opts.kill(rec);
        } catch {
          continue;
        }
      }
      const flipped = await registry.markStatus(rec.processId, "reaped");
      if (!flipped) continue;
      reaped++;
      if (opts.onReaped)
        await opts
          .onReaped(rec)
          .catch((err) => console.error("[process-reaper] onReaped hook failed:", errMessage(err)));
    }
    return { reaped };
  }

  const sweeper = createSweeper(() => leaderLease.hold(PROCESS_REAPER_LEASE_KEY, sweep), opts.intervalMs);
  return {
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    sweep,
  };
}
