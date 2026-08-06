import { swallow } from "../util/errors.ts";
import type { CoreClient } from "./core-client.ts";
import type { TaskStatus } from "../tasks/task-store.ts";
import type { TurnRequest, TurnResult } from "../types.ts";

export type CoreTurnBody = Omit<TurnRequest, "surface">;

export interface CoreCallHooks {
  onQueued?: (runId: string) => void;
  onSteered?: (runId: string) => void;
  onFirstBlock?: (text: string) => void;
  onSurfacePosted?: () => void;
  onTasks?: (tasks: Array<{ id: string; title: string; status: TaskStatus }>) => void | Promise<void>;
}

export interface CoreBridge {
  callCore(body: CoreTurnBody, hooks?: CoreCallHooks): Promise<TurnResult>;
  inFlightRuns: { add(runId: string): void; delete(runId: string): void; has(runId: string): boolean };
  inFlightRunByThread: {
    set(threadRef: string, runId: string): void;
    get(threadRef: string): string | undefined;
    clear(threadRef: string, runId: string): void;
  };
  signalRunAbort(runId: string): Promise<void>;
  fetchActiveRunForThread(threadRef: string): Promise<string | undefined>;
  ackRunDeliveryWithRetry(runId: string): void;
  reportTurnMetrics(runId: string, patch: { deliverMs?: number; slackInflightMs?: number }): void;
  checkpointRunEditRef(runId: string, editRef: string): Promise<void>;
  reportRunEditRef(runId: string, editRef: string): void;
  stageBlobInCore(bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }>;
  fetchBlobFromCore(blobId: string): Promise<Buffer>;
  fetchFileArtifactFromCore(artifactId: string, viewerId: string): Promise<Buffer>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCoreBridge(core: CoreClient, surface = "slack"): CoreBridge {
  const stageBlobInCore = async (bytes: Uint8Array): Promise<{ blobId: string; sizeBytes: number }> => {
    try {
      return await core.stageBlob(bytes);
    } catch (err) {
      if ((err as Error)?.name === "BlobTooLargeError")
        throw new Error("that request was too large — try fewer or smaller files", { cause: err });
      throw err;
    }
  };
  const fetchBlobFromCore = (blobId: string): Promise<Buffer> => core.readBlob(blobId);
  const fetchFileArtifactFromCore = (artifactId: string, viewerId: string): Promise<Buffer> =>
    core.readFileArtifact(artifactId, viewerId);

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

  const inFlightRunByThread = new Map<string, string>();

  const signalRunAbort = (runId: string): Promise<void> => core.signalRunAbort(runId);

  const fetchActiveRunForThread = (threadRef: string): Promise<string | undefined> =>
    core.activeRunForThread(threadRef);

  const ackRunDelivery = (runId: string): Promise<void> => core.ackRunDelivery(runId);

  const ACK_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
  function ackRunDeliveryWithRetry(runId: string): void {
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await ackRunDelivery(runId);
          return;
        } catch (err) {
          if (attempt >= ACK_RETRY_DELAYS_MS.length) {
            console.error(
              `[${surface}-plugin] recovery-copy ack failed for run ${runId} (giving up — the poller may re-deliver):`,
              (err as Error).message,
            );
            return;
          }
          await sleep(ACK_RETRY_DELAYS_MS[attempt]!);
        }
      }
    })().finally(() => inFlightRuns.delete(runId));
  }

  function reportTurnMetrics(runId: string, patch: { deliverMs?: number; slackInflightMs?: number }): void {
    if (patch.deliverMs === undefined && patch.slackInflightMs === undefined) return;
    void core
      .reportTurnMetrics(runId, patch)
      .catch((err) =>
        console.error(`[${surface}-plugin] turn-metrics report failed for run ${runId}:`, (err as Error).message),
      );
  }

  async function checkpointRunEditRef(runId: string, editRef: string): Promise<void> {
    await core.reportRunEditRef(runId, editRef);
  }

  function reportRunEditRef(runId: string, editRef: string): void {
    void checkpointRunEditRef(runId, editRef).catch((err) =>
      console.error(`[${surface}-plugin] delivery-state checkpoint failed for run ${runId}:`, (err as Error).message),
    );
  }

  function coreFailure(err: unknown): Error {
    swallow(`${surface}: core call`, err);
    if ((err as { code?: string })?.code === "run_stalled") {
      return new Error(
        "this request is taking unusually long — I'm still on it and will post the result here as soon as it finishes",
        { cause: err },
      );
    }
    return new Error("I couldn't reach the agent core — it may be busy or deploying; please try again in a moment", {
      cause: err,
    });
  }

  async function callCore(body: CoreTurnBody, hooks: CoreCallHooks = {}): Promise<TurnResult> {
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

  async function pollRun(runId: string, hooks: CoreCallHooks = {}): Promise<TurnResult> {
    inFlightRuns.add(runId);
    let result: TurnResult | null;
    try {
      result = await core.waitRun(runId, {
        ...(hooks.onFirstBlock ? { onFirstBlock: hooks.onFirstBlock } : {}),
        ...(hooks.onSurfacePosted ? { onSurfacePosted: hooks.onSurfacePosted } : {}),
        ...(hooks.onTasks ? { onTasks: hooks.onTasks } : {}),
      });
    } catch (err) {
      inFlightRuns.delete(runId);
      throw coreFailure(err);
    }
    if (result?.status === "refused" && result.refusalKind === "security_quarantine") {
      return result;
    }
    if (result && (result.status === "ok" || result.status === "refused" || result.status === "failed")) {
      ackRunDeliveryWithRetry(runId);
    } else {
      inFlightRuns.delete(runId);
    }
    if (result) return result;
    throw new Error("the agent finished without producing a reply");
  }

  return {
    callCore,
    inFlightRuns,
    inFlightRunByThread,
    signalRunAbort,
    fetchActiveRunForThread,
    ackRunDeliveryWithRetry,
    reportTurnMetrics,
    checkpointRunEditRef,
    reportRunEditRef,
    stageBlobInCore,
    fetchBlobFromCore,
    fetchFileArtifactFromCore,
  };
}
