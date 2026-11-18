import type { App } from "../api/app-types.ts";
import { isTerminal, type RunStore, type SessionWatch } from "../runs/run-store.ts";
import type { TurnStream } from "../runs/turn-stream.ts";
import type { TurnResult } from "../types.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import type { RunHooks } from "./turn-flow.ts";

const RUN_FALLBACK_POLL_MS = 1_000;
const RUN_STALL_BUDGET_MS = 300_000;

export function createRunWaiter(deps: {
  runs: Pick<RunStore, "get" | "watchSession">;
  turnStream: TurnStream;
  getRun: App["getRun"];
}) {
  return async function waitRun(runId: string, hooks: RunHooks = {}): Promise<TurnResult | null> {
    let replyingSignaled = false;
    let firstBlockSignaled = false;
    let surfaceSignaled = false;
    const signalReplying = (durable = false): void => {
      if (replyingSignaled || !(durable || deps.turnStream.replying(runId))) return;
      replyingSignaled = true;
      hooks.onReplying?.();
    };
    const signalFirstBlock = (text: string): void => {
      if (firstBlockSignaled || !text.trim()) return;
      firstBlockSignaled = true;
      hooks.onFirstBlock?.(text);
    };
    const signalSurface = (): void => {
      if (surfaceSignaled) return;
      surfaceSignaled = true;
      hooks.onSurfacePosted?.();
    };
    let watch: SessionWatch | undefined;
    const unsubscribe = deps.turnStream.subscribe(runId, {
      onFirstBlock: signalFirstBlock,
      onSurfacePosted: signalSurface,
    });
    let lastProgressAt = Date.now();
    let lastMark = "";
    let goalSnapshot = "";
    const emitGoal = async (): Promise<void> => {
      if (!hooks.onGoal) return;
      const goal = deps.turnStream.goal(runId);
      if (!goal) return;
      const next = JSON.stringify(goal);
      if (next === goalSnapshot) return;
      goalSnapshot = next;
      await hooks.onGoal(goal);
    };
    try {
      for (;;) {
        let run;
        try {
          run = await deps.runs.get(runId);
        } catch (err) {
          if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) throw err;
          run = undefined;
        }
        if (run !== undefined) {
          if (!run) throw new Error(`run ${runId} not found`);
          watch ??= deps.runs.watchSession(run.sessionId);
          if (deps.turnStream.surfacePosted(runId)) signalSurface();
          if (isTerminal(run.status)) {
            const view = await deps.getRun(runId);
            await emitGoal().catch(swallowAs("run wait: terminal goal refresh", undefined));
            if (view?.surfacePosted) signalSurface();
            return (view?.result as TurnResult | null | undefined) ?? null;
          }
          signalReplying(run.deliveryState?.replying === true);
          await emitGoal().catch(swallowAs("run wait: goal refresh", undefined));
          const fb = deps.turnStream.firstBlock(runId);
          if (fb?.closed) signalFirstBlock(fb.text);
          const mark = `${run.status}:${run.attempts}:${run.leaseExpiresAt ?? ""}`;
          if (mark !== lastMark) {
            lastMark = mark;
            lastProgressAt = Date.now();
          }
          if (Date.now() - lastProgressAt >= RUN_STALL_BUDGET_MS) {
            throw Object.assign(
              new Error(`run ${runId} made no progress for ${Math.round(RUN_STALL_BUDGET_MS / 1000)}s — giving up`),
              { code: "run_stalled" },
            );
          }
        }
        await (watch ? watch.changed(RUN_FALLBACK_POLL_MS) : sleep(RUN_FALLBACK_POLL_MS));
      }
    } finally {
      unsubscribe();
      watch?.close();
    }
  };
}
