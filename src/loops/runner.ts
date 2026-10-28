import type { Loop, LoopItem, LoopOutput } from "../types.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { unresolvedOutput, type CaptureOutputInput, type LoopOutputStore } from "./output-store.ts";
import type { FireOutcome, LoopStore } from "./loop-store.ts";
import { isRunnable } from "./loop-store.ts";
import { decideShip, outputCandidate, undeclaredShipActions } from "./ship-gate.ts";
import type { SuccessVerdict } from "./success-evaluation.ts";
import type { ShipGrant } from "../types.ts";
import { workOrder } from "./triage.ts";
import { isTransientFailure } from "../core/turn-error.ts";

export interface IntakeCandidate {
  sourceKey: string;
  sourceSummary?: string;
}

export type CapturedArtifact = Omit<CaptureOutputInput, "loopId" | "itemId" | "attemptId">;

export interface LoopRunnerEffects {
  enumerate(loop: Loop): Promise<IntakeCandidate[]>;
  triage?(loop: Loop): Promise<void>;
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
  persistentFailures: number;
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
    persistentFailures: 0,
  };
}

function recordFailure(summary: FireSummary, label: string, error: unknown): void {
  summary.failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  if (!isTransientFailure(error)) summary.persistentFailures += 1;
}

export function fireOutcome(summary: FireSummary): FireOutcome {
  if (summary.failures.length === 0) return "ok";
  return summary.persistentFailures > 0 ? "failed" : "transient";
}

export function fireNeedsAttention(summary: FireSummary): boolean {
  return (
    summary.ready.length > 0 ||
    summary.parked.length > 0 ||
    summary.failures.length > 0 ||
    summary.undeclaredShipActions.length > 0
  );
}

class ReviewBudget {
  private inFlight = 0;
  private readonly cap: number | undefined;
  private open: number;

  constructor(cap: number | undefined, open: number) {
    this.cap = cap;
    this.open = open;
  }

  get full(): boolean {
    return this.cap !== undefined && this.open + this.inFlight >= this.cap;
  }

  admit(): boolean {
    if (this.full) return false;
    this.inFlight += 1;
    return true;
  }

  release(opened: number): void {
    this.inFlight -= 1;
    this.open += opened;
  }

  reason(): string {
    return `${this.open} outputs waiting for review`;
  }
}

export async function runLoopFire(
  loop: Loop,
  stores: LoopStores,
  effects: LoopRunnerEffects,
  grants: ShipGrant[] = [],
): Promise<FireSummary> {
  const summary = emptySummary(loop, isRunnable(loop));
  if (!summary.ran) return summary;
  const effectiveMaxAttempts = loop.caps?.maxItemAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const budget = new ReviewBudget(
    loop.caps?.maxOpenOutputs,
    (await stores.outputs.byLoop(loop.id)).filter(unresolvedOutput).length,
  );
  if (budget.full) {
    summary.throttled = budget.reason();
    await stores.loops.recordFireOutcome(loop.id, "ok");
    return summary;
  }

  try {
    for (const candidate of await effects.enumerate(loop)) {
      const { created } = await stores.items.enqueue({ loopId: loop.id, ...candidate });
      if (created) summary.enqueued += 1;
    }
  } catch (error) {
    if (error instanceof DuplicateLoopFireError) throw error;
    recordFailure(summary, "intake", error);
  }

  await effects.triage?.(loop);

  const queued = workOrder(loop, await stores.items.queued(loop.id), await stores.items.byLoop(loop.id)).slice(
    0,
    loop.caps?.maxItemsPerFire,
  );
  const batch = loop.throttle ? queued.slice(0, Math.max(1, Math.floor(queued.length / 2))) : queued;
  const remaining = batch.values();
  let capped = false;
  let drained = false;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(loop.caps?.maxConcurrentItems ?? 1, batch.length) }, async () => {
      for (;;) {
        if (!budget.admit()) {
          capped = true;
          break;
        }
        const next = remaining.next();
        if (next.done) {
          budget.release(0);
          drained = true;
          break;
        }
        const queued = next.value;
        let item: LoopItem | null;
        try {
          item = await stores.items.claim(queued.id, undefined, loop.id);
        } catch (error) {
          budget.release(0);
          throw error;
        }
        if (!item) {
          budget.release(0);
          continue;
        }
        const claimToken = item.claimToken!;
        summary.worked += 1;

        let autoShippedCount = 0;
        let autoOutputCount = 0;
        let openedOutputs = 0;
        try {
          const { runId } = await effects.work({
            loop,
            item,
            ...(item.guidance !== undefined ? { guidance: item.guidance } : {}),
          });
          if (!(await stores.items.recordRun(item.id, runId, claimToken))) continue;
          const artifacts = await effects.captureOutputs({ loop, item, runId });
          const captured: LoopOutput[] = [];
          for (const [ordinal, artifact] of artifacts.entries()) {
            captured.push(
              await stores.outputs.capture({
                ...artifact,
                loopId: loop.id,
                itemId: item.id,
                attemptId: runId,
                ordinal,
              }),
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
            if ((await stores.items.get(item.id))?.proposal) {
              if (await stores.items.markReady(item.id, [], claimToken)) summary.ready.push(item.id);
            } else if (await stores.items.markShipped(item.id, claimToken)) summary.shipped.push(item.id);
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
          const ready = await stores.outputs.promoteAttempt(item.id, runId);
          openedOutputs = ready.length;
          autoOutputCount = ready.filter(
            (output) => decideShip(loop, outputCandidate(output), grants).outcome === "auto",
          ).length;
          for (const output of ready) {
            if (decideShip(loop, outputCandidate(output), grants).outcome !== "auto") continue;
            const currentLoop = effects.authorizeAutoShip ? await effects.authorizeAutoShip(output) : loop;
            if (!currentLoop) continue;
            const shipped = await effects.ship({ loop: currentLoop, output });
            if (shipped?.state === "shipped") {
              autoShippedCount += 1;
              openedOutputs -= 1;
            }
          }
          if (openedOutputs === 0) {
            await stores.items.markShipped(item.id);
            summary.shipped.push(item.id);
          } else {
            summary.ready.push(item.id);
          }
        } catch (error) {
          if (autoShippedCount === 0) openedOutputs = 0;
          const reason = error instanceof Error ? error.message : String(error);
          recordFailure(summary, item.sourceKey, error);
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
          budget.release(openedOutputs);
        }
      }
    }),
  );
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
  if (capped && !drained) summary.throttled ??= budget.reason();

  await stores.loops.recordFireOutcome(loop.id, fireOutcome(summary));
  return summary;
}
