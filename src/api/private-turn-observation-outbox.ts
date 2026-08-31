import { randomUUID } from "node:crypto";
import {
  createTransactionalOutboxEntry,
  validateTransactionalOutboxEntry,
  type TransactionalOutboxClaim,
  type TransactionalOutboxEntry,
  type TransactionalOutboxStorage,
} from "../persistence/transactional-outbox.ts";
import {
  observePrivateTurn,
  snapshotPrivateTurnObservation,
  type PrivateTurnObservation,
  type PrivateTurnObservationSink,
} from "./private-turn-observer.ts";

export interface PrivateTurnObservationOutbox extends PrivateTurnObservationSink {
  entry(input: PrivateTurnObservation): TransactionalOutboxEntry;
  deliver(eventRef: string): Promise<"accepted" | "duplicate" | "unconfirmed">;
  sweep(limit?: number): Promise<{ attempted: number; delivered: number; pending: number }>;
}

interface OutboxOptions {
  storage: TransactionalOutboxStorage;
  downstream: PrivateTurnObservationSink;
  timeoutMs: number;
  now?: () => number;
  leaseToken?: () => string;
  retryBaseMs?: number;
  retryMaximumMs?: number;
}

const PRIVATE_TURN_OBSERVATION_TOPIC = "qm.private_turn_observation.v1";

export function createPrivateTurnObservationOutbox(options: OutboxOptions): PrivateTurnObservationOutbox {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10_000) {
    throw new TypeError("private turn observation outbox timeoutMs must be an integer from 1 through 10000");
  }
  const now = options.now ?? Date.now;
  const nextLeaseToken = options.leaseToken ?? randomUUID;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const retryMaximumMs = options.retryMaximumMs ?? 30_000;
  if (
    !Number.isSafeInteger(retryBaseMs) ||
    retryBaseMs < 1 ||
    !Number.isSafeInteger(retryMaximumMs) ||
    retryMaximumMs < retryBaseMs
  ) {
    throw new TypeError("private turn observation retry interval is invalid");
  }

  const entry = (value: PrivateTurnObservation): TransactionalOutboxEntry => {
    const observation = snapshotPrivateTurnObservation(value);
    return createTransactionalOutboxEntry({
      id: observation.eventRef,
      topic: PRIVATE_TURN_OBSERVATION_TOPIC,
      payloadJson: JSON.stringify(observation),
      createdAt: Date.parse(observation.observedAt),
    });
  };

  const observationFromClaim = (claim: TransactionalOutboxClaim): PrivateTurnObservation => {
    const checked = validateTransactionalOutboxEntry(claim);
    if (checked.topic !== PRIVATE_TURN_OBSERVATION_TOPIC) {
      throw new TypeError("private turn observation outbox topic is invalid");
    }
    const observation = snapshotPrivateTurnObservation(JSON.parse(checked.payloadJson));
    if (observation.eventRef !== checked.id) {
      throw new TypeError("private turn observation outbox identity is invalid");
    }
    return observation;
  };

  const deliverClaim = async (claim: TransactionalOutboxClaim) => {
    const outcome = await observePrivateTurn(options.downstream, observationFromClaim(claim), options.timeoutMs);
    const completedAt = now();
    if (outcome === "accepted" || outcome === "duplicate") {
      await options.storage.deliver(claim.id, claim.leaseToken, outcome, completedAt);
      return outcome;
    }
    const delay = Math.min(retryMaximumMs, retryBaseMs * 2 ** Math.min(claim.attempts - 1, 20));
    await options.storage.retry(claim.id, claim.leaseToken, completedAt + delay, completedAt);
    return "unconfirmed" as const;
  };

  const deliver = async (eventRef: string) => {
    const claimedAt = now();
    const claim = await options.storage.claimId(
      PRIVATE_TURN_OBSERVATION_TOPIC,
      eventRef,
      nextLeaseToken(),
      Math.max(options.timeoutMs * 2, 1_000),
      claimedAt,
    );
    if (claim) return deliverClaim(claim);
    return (await options.storage.get(eventRef))?.state === "delivered" ? "duplicate" : "unconfirmed";
  };

  let sweepInFlight: Promise<{ attempted: number; delivered: number; pending: number }> | null = null;
  const sweep = (limit = 25) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("private turn observation sweep limit must be an integer from 1 through 100");
    }
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = (async () => {
      const claims = await options.storage.claim(
        PRIVATE_TURN_OBSERVATION_TOPIC,
        limit,
        nextLeaseToken(),
        Math.max(options.timeoutMs * (limit + 1), 1_000),
        now(),
      );
      let delivered = 0;
      for (const claim of claims) {
        const outcome = await deliverClaim(claim);
        if (outcome === "accepted" || outcome === "duplicate") delivered += 1;
      }
      return { attempted: claims.length, delivered, pending: claims.length - delivered };
    })().finally(() => {
      sweepInFlight = null;
    });
    return sweepInFlight;
  };

  return Object.freeze({
    entry,
    deliver,
    sweep,
    async observe(value: PrivateTurnObservation) {
      const staged = entry(value);
      await options.storage.stage(staged);
      return deliver(staged.id);
    },
  });
}
