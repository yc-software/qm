import type { PeerDelivery, PeerMessage } from "./types.ts";

interface PublishInput {
  id: string;
  orgId: string;
  senderSessionId: string;
  senderRunId: string | null;
  text: string;
  audienceExpr: string | null;
  resolvedRecipientIds: string[];
  replyTo: string | null;
  createdAt: number;
}

export interface BoardPage {
  messages: PeerMessage[];
  nextCursor: number | null;
}

export interface DeliveryRetirement {
  runId: string | null;
  dispatchedAt: number;
  consumedAt: number | null;
  lastStatus: string;
}

export interface DeliveryPark {
  nextAttemptAt: number | null;
  lastStatus: string;
  lastReason: string;
}

export interface MessageBoardStore {
  publish(input: PublishInput): Promise<PeerMessage>;
  get(orgId: string, messageId: string): Promise<PeerMessage | null>;
  list(orgId: string, opts: { afterSeq?: number; limit: number }): Promise<BoardPage>;
  deliveries(messageId: string): Promise<PeerDelivery[]>;
  claimDue(opts: { now: number; leaseMs: number; limit: number }): Promise<PeerDelivery[]>;
  retire(messageId: string, recipientSessionId: string, retirement: DeliveryRetirement): Promise<void>;
  park(messageId: string, recipientSessionId: string, park: DeliveryPark): Promise<void>;
  awaitingConsumption(limit: number): Promise<PeerDelivery[]>;
  markConsumed(messageId: string, recipientSessionId: string, at: number): Promise<void>;
  close?(): Promise<void>;
}

export function deliveryProjection(delivery: PeerDelivery): {
  recipientSessionId: string;
  runId: string | null;
  dispatchedAt: number | null;
  consumedAt: number | null;
  park: { terminal: boolean; attempts: number; status: string | null; reason: string | null };
} {
  return {
    recipientSessionId: delivery.recipientSessionId,
    runId: delivery.runId,
    dispatchedAt: delivery.dispatchedAt,
    consumedAt: delivery.consumedAt,
    park: {
      terminal: delivery.nextAttemptAt === null && delivery.dispatchedAt === null,
      attempts: delivery.attempts,
      status: delivery.lastStatus,
      reason: delivery.lastReason,
    },
  };
}
