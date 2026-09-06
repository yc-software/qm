import type { LoopOutput, LoopOutputState, LoopShipResult } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { hashId } from "../util/crypto.ts";
import { randomUUID } from "node:crypto";

export interface CaptureOutputInput {
  loopId: string;
  itemId: string;
  attemptId: string;
  ordinal?: number;
  shipAction: string;
  title: string;
  capturedBy: LoopOutput["capturedBy"];
  label?: string;
  externalRef?: string;
  summary?: string;
}

interface ClassifyOutputInput {
  title?: string;
  summary?: string;
  label?: string;
  externalRef?: string;
}

interface DecideOutputInput {
  actorId: string;
  note?: string;
}

export interface LoopOutputStore {
  capture(input: CaptureOutputInput): Promise<LoopOutput>;
  get(id: string): Promise<LoopOutput | null>;
  byLoop(loopId: string): Promise<LoopOutput[]>;
  byItem(itemId: string): Promise<LoopOutput[]>;
  awaitingReview(loopId: string): Promise<LoopOutput[]>;
  classify(id: string, input: ClassifyOutputInput): Promise<LoopOutput | null>;
  promoteAttempt(itemId: string, attemptId: string): Promise<LoopOutput[]>;
  supersedeAttempt(itemId: string, attemptId: string): Promise<LoopOutput[]>;
  supersedeActiveSiblings(itemId: string, exceptOutputId: string): Promise<LoopOutput[]>;
  claimShipping(id: string, claimedAt?: number): Promise<LoopOutput | null>;
  beginShipAttempt(id: string, claimToken: string, shipFireKey: string): Promise<LoopOutput | null>;
  markUnconfirmed(id: string, claimToken: string): Promise<LoopOutput | null>;
  confirmShipped(id: string, input: DecideOutputInput): Promise<LoopOutput | null>;
  completeShipping(
    id: string,
    claimToken: string,
    input: DecideOutputInput,
    result: LoopShipResult,
  ): Promise<LoopOutput | null>;
  failShipping(id: string, claimToken: string): Promise<LoopOutput | null>;
  returnToLoop(id: string, input: DecideOutputInput): Promise<LoopOutput | null>;
  expireOlderThan(loopId: string, cutoff: number): Promise<LoopOutput[]>;
  deleteByLoop(loopId: string): Promise<void>;
}

function loopOutputId(
  loopId: string,
  itemId: string,
  attemptId: string,
  shipAction: string,
  ordinal: number,
  externalRef?: string,
): string {
  return hashId([
    contentPart(loopId),
    contentPart(itemId),
    contentPart(attemptId),
    contentPart(shipAction),
    contentPart(ordinal),
    contentPart(externalRef),
  ]);
}

const SHIP_LEASE_MS = 600_000;

const DECIDED: ReadonlySet<LoopOutputState> = new Set<LoopOutputState>(["shipped", "returned"]);

export function isDecided(output: LoopOutput): boolean {
  return DECIDED.has(output.state);
}

export function unresolvedOutput(output: LoopOutput): boolean {
  return output.state === "ready" || output.state === "shipping" || output.state === "unconfirmed";
}

export function createLoopOutputStore(
  backing: DurableMap<LoopOutput> = createMemoryMap<LoopOutput>(),
): LoopOutputStore {
  const forLoop = async (loopId: string): Promise<LoopOutput[]> =>
    (await backing.all()).filter((output) => output.loopId === loopId);

  const byAttempt = async (itemId: string, attemptId: string): Promise<LoopOutput[]> =>
    (await backing.all()).filter((output) => output.itemId === itemId && output.attemptId === attemptId);

  if (!backing.update) throw new Error("loop outputs need atomic durable updates");
  const update = backing.update.bind(backing);
  const applyIf = async (
    id: string,
    when: (output: LoopOutput) => boolean,
    change: (output: LoopOutput, now: number) => LoopOutput,
  ): Promise<LoopOutput | null> => {
    let applied = false;
    const after = await update(id, (output) => {
      if (!when(output)) return output;
      applied = true;
      return change(output, Date.now());
    });
    return applied ? after : null;
  };

  return {
    async capture(input) {
      const id = loopOutputId(
        input.loopId,
        input.itemId,
        input.attemptId,
        input.shipAction,
        input.ordinal ?? 0,
        input.externalRef,
      );
      const now = Date.now();
      const prior = (await forLoop(input.loopId)).filter(
        (output) =>
          output.itemId === input.itemId &&
          output.attemptId !== input.attemptId &&
          output.shipAction === input.shipAction &&
          output.externalRef === input.externalRef,
      );
      const candidate: LoopOutput = {
        id,
        loopId: input.loopId,
        itemId: input.itemId,
        attemptId: input.attemptId,
        shipAction: input.shipAction,
        title: input.title,
        state: "staged",
        capturedBy: input.capturedBy,
        createdAt: now,
        updatedAt: now,
        ...(prior.length ? { supersedesOutputIds: prior.map((output) => output.id) } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      };
      const captured = await backing.putIfAbsent(id, candidate);
      for (const output of prior) {
        await update(output.id, (current) => ({
          ...current,
          supersededByOutputIds: [...new Set([...(current.supersededByOutputIds ?? []), captured.id])],
          updatedAt: Date.now(),
        }));
      }
      return captured;
    },
    get: (id) => backing.get(id),
    byLoop: forLoop,
    async byItem(itemId) {
      return (await backing.all()).filter((output) => output.itemId === itemId);
    },
    async awaitingReview(loopId) {
      return (await forLoop(loopId))
        .filter((output) => output.state === "ready")
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async classify(id, input) {
      return update(id, (output) => ({ ...output, ...input, updatedAt: Date.now() }));
    },
    async promoteAttempt(itemId, attemptId) {
      const promoted: LoopOutput[] = [];
      for (const output of await byAttempt(itemId, attemptId)) {
        const after = await applyIf(
          output.id,
          (current) => current.state === "staged",
          (current, now) => ({ ...current, state: "ready", updatedAt: now }),
        );
        if (after) promoted.push(after);
      }
      return promoted;
    },
    async supersedeAttempt(itemId, attemptId) {
      const superseded: LoopOutput[] = [];
      for (const output of await byAttempt(itemId, attemptId)) {
        const after = await applyIf(
          output.id,
          (current) => current.state === "staged" || current.state === "ready",
          (current, now) => ({ ...current, state: "superseded", updatedAt: now }),
        );
        if (after) superseded.push(after);
      }
      return superseded;
    },
    async supersedeActiveSiblings(itemId, exceptOutputId) {
      const superseded: LoopOutput[] = [];
      for (const output of (await backing.all()).filter(
        (candidate) =>
          candidate.itemId === itemId &&
          candidate.id !== exceptOutputId &&
          (candidate.state === "staged" || unresolvedOutput(candidate)),
      )) {
        const after = await applyIf(
          output.id,
          (current) => current.state === "staged" || unresolvedOutput(current),
          (current, now) => ({ ...current, state: "superseded", updatedAt: now }),
        );
        if (after) superseded.push(after);
      }
      return superseded;
    },
    async claimShipping(id, claimedAt = Date.now()) {
      return applyIf(
        id,
        (output) =>
          output.state === "ready" ||
          (output.state === "shipping" && (output.claimedAt ?? 0) + SHIP_LEASE_MS <= claimedAt),
        (output) => ({ ...output, state: "shipping", claimedAt, claimToken: randomUUID(), updatedAt: claimedAt }),
      );
    },
    async beginShipAttempt(id, claimToken, shipFireKey) {
      return applyIf(
        id,
        (output) => output.state === "shipping" && output.claimToken === claimToken,
        (output, now) => ({ ...output, shipFireKey, updatedAt: now }),
      );
    },
    async markUnconfirmed(id, claimToken) {
      return applyIf(
        id,
        (output) => output.state === "shipping" && output.claimToken === claimToken,
        (output, now) => ({
          ...output,
          state: "unconfirmed",
          claimedAt: undefined,
          claimToken: undefined,
          updatedAt: now,
        }),
      );
    },
    async confirmShipped(id, input) {
      return applyIf(
        id,
        (output) => output.state === "unconfirmed",
        (output, now) => ({
          ...output,
          state: "shipped",
          decidedBy: input.actorId,
          decidedAt: now,
          updatedAt: now,
          ...(input.note !== undefined ? { decisionNote: input.note } : {}),
        }),
      );
    },
    async completeShipping(id, claimToken, input, result) {
      return applyIf(
        id,
        (output) => output.state === "shipping" && output.claimToken === claimToken,
        (output, now) => ({
          ...output,
          state: "shipped",
          decidedBy: input.actorId,
          decidedAt: now,
          updatedAt: now,
          shipResult: result,
          claimedAt: undefined,
          claimToken: undefined,
          ...(input.note !== undefined ? { decisionNote: input.note } : {}),
        }),
      );
    },
    async failShipping(id, claimToken) {
      return applyIf(
        id,
        (output) => output.state === "shipping" && output.claimToken === claimToken,
        (output, now) => ({
          ...output,
          state: "ready",
          claimedAt: undefined,
          claimToken: undefined,
          updatedAt: now,
        }),
      );
    },
    async returnToLoop(id, input) {
      return applyIf(
        id,
        (output) => output.state === "ready" || output.state === "unconfirmed",
        (output, now) => ({
          ...output,
          state: "returned",
          decidedBy: input.actorId,
          decidedAt: now,
          updatedAt: now,
          ...(input.note !== undefined ? { decisionNote: input.note } : {}),
        }),
      );
    },
    async expireOlderThan(loopId, cutoff) {
      const stale = (await forLoop(loopId)).filter((output) => output.state === "ready" && output.createdAt < cutoff);
      const expired: LoopOutput[] = [];
      for (const output of stale) {
        const next = await applyIf(
          output.id,
          (current) => current.state === "ready",
          (current, now) => ({ ...current, state: "expired", updatedAt: now }),
        );
        if (next) expired.push(next);
      }
      return expired;
    },
    async deleteByLoop(loopId) {
      for (const output of await forLoop(loopId)) await backing.delete(output.id);
    },
  };
}
