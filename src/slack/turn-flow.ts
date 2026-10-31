import { swallow } from "../util/errors.ts";
import { createInFlightThreadMap, type GoalNoticeView } from "./lib.ts";
import { ackRunDeliveryWithRetry, type CoreTurnBody } from "../api/surface-core-client.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { TurnResult } from "../types.ts";
import { GENERIC_FAILURE_TEXT } from "../../plugins/chassis/src/failure-copy.ts";

class SlackTurnFailure extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export function slackFailureText(err: unknown): string {
  return err instanceof SlackTurnFailure ? err.message : GENERIC_FAILURE_TEXT;
}

interface TurnHooks {
  deferDeliveryAck?: boolean;
  onQueued?: (runId: string) => void | Promise<void>;
  onSteered?: (runId: string) => void | Promise<void>;
  onReplying?: () => void;
  onFirstBlock?: (text: string) => void;
  onSurfacePosted?: () => void;
  onGoal?: (goal: GoalNoticeView) => void;
}

export interface TurnFlow {
  callCore(body: CoreTurnBody, hooks?: TurnHooks): Promise<TurnResult>;
  inFlightRuns: { add(runId: string): void; delete(runId: string): void; has(runId: string): boolean };
  inFlightRunByThread: ReturnType<typeof createInFlightThreadMap>;
  ackRunDelivery(runId: string): void;
}

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
    void ackRunDeliveryWithRetry(core, runId)
      .catch((err: unknown) =>
        console.error(
          `[slack-plugin] delivery ack failed for run ${runId} (giving up — the poller re-delivers unacked runs):`,
          (err as Error).message,
        ),
      )
      .finally(() => inFlightRuns.delete(runId));
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
      await hooks.onSteered?.(queued.runId);
      return { status: "silent", steered: true };
    }
    inFlightRuns.add(queued.runId);
    try {
      await hooks.onQueued?.(queued.runId);
      return await pollRun(queued.runId, hooks);
    } finally {
      inFlightRuns.delete(queued.runId);
    }
  }

  async function pollRun(runId: string, hooks: TurnHooks): Promise<TurnResult> {
    inFlightRuns.add(runId);
    let result: TurnResult | null;
    try {
      result = await core.waitRun(runId, {
        ...(hooks.onReplying ? { onReplying: hooks.onReplying } : {}),
        ...(hooks.onFirstBlock ? { onFirstBlock: hooks.onFirstBlock } : {}),
        ...(hooks.onSurfacePosted ? { onSurfacePosted: hooks.onSurfacePosted } : {}),
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
      if (!hooks.deferDeliveryAck) ackRunDelivery(runId);
    } else {
      inFlightRuns.delete(runId);
    }
    if (result) return result;
    throw new SlackTurnFailure("the agent finished without producing a reply", undefined);
  }

  return { callCore, inFlightRuns, inFlightRunByThread, ackRunDelivery };
}
