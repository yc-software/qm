import { TurnHandedOff } from "../core/turn-error.ts";
import type { Loop, LoopItem, LoopOutput } from "../types.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { unresolvedOutput, type CaptureOutputInput, type LoopOutputStore } from "./output-store.ts";
import type { LoopStore } from "./loop-store.ts";
import { isRunnable } from "./loop-store.ts";
import { decideShip, outputCandidate, undeclaredShipActions } from "./ship-gate.ts";
import type { SuccessVerdict } from "./success-evaluation.ts";
import type { ShipGrant } from "../types.ts";

export class LoopFireDeferred extends Error {}

export interface IntakeCandidate {
  sourceKey: string;
  sourceSummary?: string;
}

export type CapturedArtifact = Omit<CaptureOutputInput, "loopId" | "itemId" | "attemptId">;

export interface LoopRunnerEffects {
  enumerate(loop: Loop): Promise<IntakeCandidate[]>;
  work(input: { loop: Loop; item: LoopItem; guidance?: string }): Promise<{ runId: string }>;
  captureOutputs(input: { loop: Loop; item: LoopItem; runId: string }): Promise<CapturedArtifact[]>;
  evaluate(input: { loop: Loop; item: LoopItem; attempt: number; runId: string }): Promise<SuccessVerdict>;
  ship(input: { loop: Loop; output: LoopOutput }): Promise<LoopOutput | null>;
  authorizeAutoShip?(output: LoopOutput): Promise<Loop | null>;
}

export interface LoopStores {
  loops: LoopStore;
  items: LoopItemLedger;
  outputs: LoopOutputStore;
}

export interface FireSummary {
  loopId: string;
  ran: boolean;
  enqueued: number;
  worked: number;
  ready: string[];
  shipped: string[];
  parked: string[];
  continued: string[];
  undeclaredShipActions: string[];
  failures: string[];
  throttled?: string;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

export class DuplicateLoopFireError extends Error {}

function emptySummary(loop: Loop, ran: boolean): FireSummary {
  return {
    loopId: loop.id,
    ran,
    enqueued: 0,
    worked: 0,
    ready: [],
    shipped: [],
    parked: [],
    continued: [],
    undeclaredShipActions: [],
    failures: [],
  };
}

export function fireNeedsAttention(summary: FireSummary): boolean {
  return (
    summary.ready.length > 0 ||
    summary.parked.length > 0 ||
    summary.failures.length > 0 ||
    summary.undeclaredShipActions.length > 0
  );
}

export interface LoopFireProgress {
  batch?: string[];
  summary?: FireSummary;
}

export async function runLoopFire(
  loop: Loop,
  stores: LoopStores,
  effects: LoopRunnerEffects,
  grants: ShipGrant[] = [],
  continuation?: { fireKey: string; progress: LoopFireProgress; save(): Promise<void> },
): Promise<FireSummary> {
  const summary = continuation?.progress.summary ?? emptySummary(loop, isRunnable(loop));
  if (continuation) continuation.progress.summary = summary;
  if (!isRunnable(loop)) return emptySummary(loop, false);
  const effectiveMaxAttempts = loop.caps?.maxItemAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const openOutputs = (await stores.outputs.byLoop(loop.id)).filter(unresolvedOutput).length;
  if (
    !continuation?.progress.batch &&
    loop.caps?.maxOpenOutputs !== undefined &&
    openOutputs >= loop.caps.maxOpenOutputs
  ) {
    summary.throttled = `${openOutputs} outputs waiting for review`;
    await stores.loops.recordFireOutcome(loop.id, false);
    return summary;
  }

  if (!continuation?.progress.batch) {
    try {
      for (const candidate of await effects.enumerate(loop)) {
        const { created } = await stores.items.enqueue({ loopId: loop.id, ...candidate });
        if (created) summary.enqueued += 1;
      }
    } catch (error) {
      if (error instanceof TurnHandedOff || error instanceof LoopFireDeferred) throw error;
      if (error instanceof DuplicateLoopFireError) throw error;
      summary.failures.push(`intake: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let batch = continuation?.progress.batch;
  if (!batch) {
    const queued = await stores.items.queued(loop.id, loop.caps?.maxItemsPerFire);
    batch = (loop.throttle ? queued.slice(0, Math.max(1, Math.floor(queued.length / 2))) : queued).map(
      (item) => item.id,
    );
    if (continuation) {
      continuation.progress.batch = batch;
      await continuation.save();
    }
  }
  for (const itemId of batch) {
    const prior = await stores.items.get(itemId);
    const item =
      prior?.status === "ready" && continuation && prior.claimFireKey === continuation.fireKey
        ? prior
        : await stores.items.claim(itemId, undefined, continuation?.fireKey);
    if (!item) continue;
    const claimToken = item.claimToken!;
    if (prior?.claimFireKey !== continuation?.fireKey || !continuation) summary.worked += 1;

    let autoShippedCount = 0;
    let autoOutputCount = 0;
    try {
      let runId = item.runIds.at(-1);
      if (item.status !== "ready") {
        const worked = await effects.work({
          loop,
          item,
          ...(item.guidance !== undefined ? { guidance: item.guidance } : {}),
        });
        runId = worked.runId;
        if (!(await stores.items.recordRun(item.id, runId, claimToken))) continue;
        const artifacts = await effects.captureOutputs({ loop, item, runId });
        const captured: LoopOutput[] = [];
        for (const [ordinal, artifact] of artifacts.entries()) {
          captured.push(
            await stores.outputs.capture({ ...artifact, loopId: loop.id, itemId: item.id, attemptId: runId, ordinal }),
          );
        }

        const held = await stores.items.get(item.id);
        if (held?.status !== "in_progress" || held.claimToken !== claimToken) {
          await stores.outputs.supersedeAttempt(item.id, runId);
          continue;
        }

        const undeclared = undeclaredShipActions(loop, captured);
        if (undeclared.length > 0) {
          summary.undeclaredShipActions.push(...undeclared);
          await stores.outputs.supersedeAttempt(item.id, runId);
          await stores.items.park(item.id, `undeclared ship action: ${undeclared.join(", ")}`, claimToken);
          summary.parked.push(item.id);
          continue;
        }

        const verdict = await effects.evaluate({ loop, item, attempt: item.attempts, runId });
        if (verdict.outcome === "park") {
          await stores.outputs.supersedeAttempt(item.id, runId);
          await stores.items.park(item.id, verdict.reason, claimToken);
          summary.parked.push(item.id);
          continue;
        }
        if (verdict.outcome === "continue") {
          await stores.outputs.supersedeAttempt(item.id, runId);
          await stores.items.returnToWork(item.id, verdict.reason, claimToken);
          summary.continued.push(item.id);
          continue;
        }

        if (captured.length === 0) {
          await stores.items.markShipped(item.id, claimToken);
          summary.shipped.push(item.id);
          continue;
        }

        const markedReady = await stores.items.markReady(
          item.id,
          captured.map((output) => output.id),
          claimToken,
        );
        if (!markedReady) {
          await stores.outputs.supersedeAttempt(item.id, runId);
          continue;
        }
      }
      if (!runId) throw new Error(`loop item ${item.id} has no recorded work run`);
      await stores.outputs.promoteAttempt(item.id, runId);
      const ready = (await stores.outputs.byItem(item.id)).filter(
        (output) =>
          output.attemptId === runId &&
          (output.state === "ready" ||
            output.state === "shipping" ||
            output.state === "shipped" ||
            output.state === "unconfirmed"),
      );
      const autoShipped: string[] = [];
      autoOutputCount = ready.filter(
        (output) => decideShip(loop, outputCandidate(output), grants).outcome === "auto",
      ).length;
      for (const output of ready) {
        if (output.state === "unconfirmed") continue;
        if (output.state === "shipped") {
          autoShipped.push(output.id);
          autoShippedCount += 1;
          continue;
        }
        if (decideShip(loop, outputCandidate(output), grants).outcome !== "auto") continue;
        const currentLoop = effects.authorizeAutoShip ? await effects.authorizeAutoShip(output) : loop;
        if (!currentLoop) continue;
        const shipped = await effects.ship({ loop: currentLoop, output });
        if (shipped?.state === "shipped") {
          autoShipped.push(output.id);
          autoShippedCount += 1;
        }
      }
      if (autoShipped.length === ready.length) {
        await stores.items.markShipped(item.id);
        summary.shipped.push(item.id);
      } else {
        summary.ready.push(item.id);
      }
    } catch (error) {
      if (error instanceof TurnHandedOff || error instanceof LoopFireDeferred) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      summary.failures.push(`${item.sourceKey}: ${reason}`);
      if (autoShippedCount > 0) {
        const partialReason = `partial auto-ship: ${autoShippedCount} of ${autoOutputCount} actions completed before failure — needs human review`;
        await stores.items.park(item.id, partialReason);
        summary.parked.push(item.id);
        continue;
      }
      const latestRunId = (await stores.items.get(item.id))?.runIds.at(-1);
      if (latestRunId) await stores.outputs.supersedeAttempt(item.id, latestRunId);
      const exhausted = item.attempts >= effectiveMaxAttempts;
      if (exhausted) {
        await stores.items.park(item.id, reason, claimToken);
        summary.parked.push(item.id);
      } else {
        await stores.items.returnToWork(item.id, reason, claimToken);
        summary.continued.push(item.id);
      }
    } finally {
      await continuation?.save();
    }
  }

  await stores.loops.recordFireOutcome(loop.id, summary.failures.length > 0);
  return summary;
}
