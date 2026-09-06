import { swallow } from "../util/errors.ts";
import { sleep, createInFlightThreadMap, type GoalNoticeView, type RunTaskView } from "./lib.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { TurnRequest, TurnResult } from "../types.ts";
import { GENERIC_FAILURE_CLAUSE, GENERIC_FAILURE_TEXT } from "../../plugins/chassis/src/failure-copy.ts";

class SlackTurnFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export function slackFailureText(err: unknown): string {
  return err instanceof SlackTurnFailure ? err.message : GENERIC_FAILURE_TEXT;
}

export function slackFailureClause(err: unknown): string {
  return err instanceof SlackTurnFailure ? err.message : GENERIC_FAILURE_CLAUSE;
}

export type CoreTurnBody = Omit<TurnRequest, "surface">;

interface TurnHooks {
  deferOkAck?: boolean;
  onQueued?: (runId: string) => void;
  onSteered?: (runId: string) => void;
  onFirstBlock?: (text: string) => void;
  onSurfacePosted?: () => void;
  onTasks?: (tasks: RunTaskView[]) => void;
  onGoal?: (goal: GoalNoticeView) => void;
}

export interface TurnFlow {
  callCore(body: CoreTurnBody, hooks?: TurnHooks): Promise<TurnResult>;
  inFlightRuns: { add(runId: string): void; delete(runId: string): void; has(runId: string): boolean };
  inFlightRunByThread: ReturnType<typeof createInFlightThreadMap>;
  ackRunDelivery(runId: string): void;
}

const ACK_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

export function createTurnFlow(core: SlackCoreClient): TurnFlow {
  const inFlightRunPins = new Map<string, number>();
  const inFlightRuns = {
    add: (runId: string): void => void inFlightRunPins.set(runId, (inFlightRunPins.get(runId) ?? 0) + 1),
    delete: (runId: string): void => {
      const held = inFlightRunPins.get(runId) ?? 0;
      if (held <= 1) inFlightRunPins.delete(runId);
      else inFlightRunPins.set(runId, held - 1);
    },
    has: (runId: string): boolean => inFlightRunPins.has(runId),
  };

  const inFlightRunByThread = createInFlightThreadMap();

  function ackRunDelivery(runId: string): void {
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await core.ackRunDelivery(runId);
          return;
        } catch (err) {
          if (attempt >= ACK_RETRY_DELAYS_MS.length) {
            console.error(
              `[slack-plugin] delivery ack failed for run ${runId} (giving up — the poller re-delivers unacked runs):`,
              (err as Error).message,
            );
            return;
          }
          await sleep(ACK_RETRY_DELAYS_MS[attempt]!);
        }
      }
    })().finally(() => inFlightRuns.delete(runId));
  }

  function coreFailure(err: unknown): Error {
    swallow("slack: core call", err);
    if ((err as { code?: string })?.code === "run_stalled") {
      return new SlackTurnFailure(
        "this request is taking unusually long — I'm still on it and will post the result here as soon as it finishes",
        err,
      );
    }
    return new SlackTurnFailure(GENERIC_FAILURE_TEXT, err);
  }

  async function callCore(body: CoreTurnBody, hooks: TurnHooks = {}): Promise<TurnResult> {
    let queued: TurnResult;
    try {
      queued = await core.submitTurn({ async: true, ...body });
    } catch (err) {
      throw coreFailure(err);
    }
    if (queued.status !== "queued" || !queued.runId) return queued;
    if (queued.steered) {
      hooks.onSteered?.(queued.runId);
      return { status: "silent", steered: true };
    }
    hooks.onQueued?.(queued.runId);
    return pollRun(queued.runId, hooks);
  }

  async function pollRun(runId: string, hooks: TurnHooks): Promise<TurnResult> {
    inFlightRuns.add(runId);
    let result: TurnResult | null;
    try {
      result = await core.waitRun(runId, {
        ...(hooks.onFirstBlock ? { onFirstBlock: hooks.onFirstBlock } : {}),
        ...(hooks.onSurfacePosted ? { onSurfacePosted: hooks.onSurfacePosted } : {}),
        ...(hooks.onTasks ? { onTasks: hooks.onTasks } : {}),
        ...(hooks.onGoal ? { onGoal: hooks.onGoal } : {}),
      });
    } catch (err) {
      inFlightRuns.delete(runId);
      throw coreFailure(err);
    }
    if (result?.status === "refused" && result.refusalKind === "security_quarantine") {
      return result;
    }
    if (result && (result.status === "ok" || result.status === "refused" || result.status === "failed")) {
      if (!(result.status === "ok" && hooks.deferOkAck)) ackRunDelivery(runId);
    } else {
      inFlightRuns.delete(runId);
    }
    if (result) return result;
    throw new SlackTurnFailure("the agent finished without producing a reply", undefined);
  }

  return { callCore, inFlightRuns, inFlightRunByThread, ackRunDelivery };
}
