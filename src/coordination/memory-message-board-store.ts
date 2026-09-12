import { createKeyedQueue } from "../util/async.ts";
import type { PeerDelivery, PeerMessage } from "./types.ts";
import type { BoardPage, DeliveryPark, DeliveryRetirement, MessageBoardStore } from "./message-board.ts";

export function createMemoryMessageBoardStore(): MessageBoardStore {
  const messages = new Map<string, PeerMessage>();
  const deliveries = new Map<string, Map<string, PeerDelivery>>();
  const serialize = createKeyedQueue<string>();
  let nextSeq = 1;

  const allDeliveries = (): PeerDelivery[] =>
    [...deliveries.values()].flatMap((byRecipient) => [...byRecipient.values()]);
  const compareText = (a: string, b: string): number => {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  };
  const byKey = (a: PeerDelivery, b: PeerDelivery): number =>
    a.messageId === b.messageId
      ? compareText(a.recipientSessionId, b.recipientSessionId)
      : compareText(a.messageId, b.messageId);

  const patch = (messageId: string, recipientSessionId: string, fn: (row: PeerDelivery) => PeerDelivery): void => {
    const byRecipient = deliveries.get(messageId);
    const row = byRecipient?.get(recipientSessionId);
    if (byRecipient && row) byRecipient.set(recipientSessionId, fn(row));
  };

  return {
    publish(input) {
      return serialize("board", async () => {
        const message: PeerMessage = {
          id: input.id,
          seq: nextSeq++,
          orgId: input.orgId,
          senderSessionId: input.senderSessionId,
          senderRunId: input.senderRunId,
          text: input.text,
          audienceExpr: input.audienceExpr,
          resolvedRecipientIds: [...input.resolvedRecipientIds],
          replyTo: input.replyTo,
          createdAt: input.createdAt,
        };
        const byRecipient = new Map<string, PeerDelivery>();
        for (const recipientSessionId of input.resolvedRecipientIds) {
          byRecipient.set(recipientSessionId, {
            messageId: message.id,
            recipientSessionId,
            runId: null,
            dispatchedAt: null,
            consumedAt: null,
            attempts: 0,
            nextAttemptAt: input.createdAt,
            lastStatus: null,
            lastReason: null,
          });
        }
        messages.set(message.id, message);
        deliveries.set(message.id, byRecipient);
        return message;
      });
    },
    async get(orgId, messageId) {
      const message = messages.get(messageId);
      return message && message.orgId === orgId ? message : null;
    },
    async list(orgId, opts): Promise<BoardPage> {
      const after = opts.afterSeq ?? 0;
      const page = [...messages.values()]
        .filter((message) => message.orgId === orgId && message.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, opts.limit);
      return { messages: page, nextCursor: page.length === opts.limit ? (page.at(-1)?.seq ?? null) : null };
    },
    async deliveries(messageId) {
      return [...(deliveries.get(messageId)?.values() ?? [])].sort(byKey);
    },
    claimDue(opts) {
      return serialize("board", async () =>
        allDeliveries()
          .filter((row) => row.dispatchedAt === null && row.nextAttemptAt !== null && row.nextAttemptAt <= opts.now)
          .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0) || byKey(a, b))
          .slice(0, opts.limit)
          .map((row) => {
            const claimed: PeerDelivery = {
              ...row,
              attempts: row.attempts + 1,
              nextAttemptAt: opts.now + opts.leaseMs,
            };
            patch(row.messageId, row.recipientSessionId, () => claimed);
            return claimed;
          }),
      );
    },
    retire(messageId, recipientSessionId, retirement: DeliveryRetirement) {
      return serialize("board", async () =>
        patch(messageId, recipientSessionId, (row) => ({
          ...row,
          runId: retirement.runId ?? row.runId,
          dispatchedAt: retirement.dispatchedAt,
          consumedAt: retirement.consumedAt,
          nextAttemptAt: null,
          lastStatus: retirement.lastStatus,
        })),
      );
    },
    park(messageId, recipientSessionId, parked: DeliveryPark) {
      return serialize("board", async () =>
        patch(messageId, recipientSessionId, (row) => ({
          ...row,
          nextAttemptAt: parked.nextAttemptAt,
          lastStatus: parked.lastStatus,
          lastReason: parked.lastReason,
        })),
      );
    },
    async awaitingConsumption(limit) {
      return allDeliveries()
        .filter((row) => row.dispatchedAt !== null && row.consumedAt === null && row.runId !== null)
        .sort(byKey)
        .slice(0, limit);
    },
    markConsumed(messageId, recipientSessionId, at) {
      return serialize("board", async () =>
        patch(messageId, recipientSessionId, (row) => ({ ...row, consumedAt: at })),
      );
    },
  };
}
