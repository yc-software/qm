import { createHash } from "node:crypto";
import { evaluateAudience } from "./audience.ts";
import type { CoordinationRepository, PeerMessageQuery, CoordinationRunFence } from "./repository.ts";
import { CoordinationError, type AudienceCandidate, type PeerMessage } from "./types.ts";

export interface PublishPeerMessage {
  senderId: string;
  senderRunId: string;
  idempotencyKey: string;
  text: string;
  audience: string;
  replyTo?: string;
}

export type BoardQuery = Partial<PeerMessageQuery>;

export function createPeerBoard(repository: CoordinationRepository) {
  const candidates = async (): Promise<AudienceCandidate[]> =>
    (await repository.list("peer"))
      .filter((peer) => peer.state !== "deleted")
      .map(({ id, name, version, character }) => ({ id, name, version, character }));
  return {
    async preview(audience: string) {
      const input = await candidates();
      return { candidates: input, recipientIds: await evaluateAudience(audience, input) };
    },
    async publish(input: PublishPeerMessage, fence?: CoordinationRunFence): Promise<PeerMessage> {
      if (!input.text.trim() || Buffer.byteLength(input.text) > 64 * 1024)
        throw new CoordinationError(400, "invalid_message", "message must contain 1–65536 bytes");
      if (!input.idempotencyKey || input.idempotencyKey.length > 200)
        throw new CoordinationError(
          400,
          "invalid_idempotency_key",
          "provide an idempotency key of at most 200 characters",
        );
      const id = createHash("sha256")
        .update(JSON.stringify([input.senderId, input.idempotencyKey]))
        .digest("hex");
      const sameRequest = (existing: PeerMessage) => {
        if (
          existing.senderId !== input.senderId ||
          existing.text !== input.text ||
          existing.audience !== input.audience ||
          existing.replyTo !== (input.replyTo ?? null)
        )
          throw new CoordinationError(409, "idempotency_conflict", "message key already names a different request");
        return existing;
      };
      const prior = await repository.get("message", id);
      if (prior) return sameRequest(prior);
      const snapshot = await candidates();
      const recipientIds = await evaluateAudience(input.audience, snapshot);
      return repository.transaction(
        [`message:${id}`, ...(input.replyTo ? [`message:${input.replyTo}`] : [])],
        async (tx) => {
          const existing = await tx.get("message", id);
          if (existing) return sameRequest(existing);
          const sender = await tx.get("peer", input.senderId);
          if (!sender || sender.state !== "active")
            throw new CoordinationError(409, "sender_inactive", "sender is not active");
          const parent = input.replyTo ? await tx.get("message", input.replyTo) : null;
          if (input.replyTo && !parent) throw new CoordinationError(404, "message_not_found", "reply target not found");
          const now = Date.now();
          const sequence = await tx.event("message", id, now);
          const message: PeerMessage = {
            id,
            senderId: sender.id,
            senderRunId: input.senderRunId,
            senderName: sender.name,
            text: input.text,
            audience: input.audience,
            candidates: snapshot,
            recipientIds,
            replyTo: input.replyTo ?? null,
            threadId: parent?.threadId ?? id,
            createdAt: now,
            sequence,
          };
          await tx.put("message", message);
          for (const recipientId of recipientIds) {
            await tx.put("delivery", {
              id: `${id}:${recipientId}`,
              messageId: id,
              recipientId,
              state: "queued",
              attempts: 0,
              runId: null,
              reason: null,
              createdAt: now,
              updatedAt: now,
              leaseToken: null,
              leaseUntil: 0,
            });
          }
          return message;
        },
        fence,
      );
    },
    async get(id: string) {
      const message = await repository.get("message", id);
      if (!message) throw new CoordinationError(404, "message_not_found", "message not found");
      return { message, deliveries: await repository.list("delivery", { messageId: id }) };
    },
    async list(query: BoardQuery = {}) {
      const limit = query.limit ?? 50;
      const after = query.after ?? 0;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new CoordinationError(400, "invalid_cursor", "provide a nonnegative cursor and limit between 1 and 200");
      return repository.messagePage({ ...query, after, limit });
    },
    events: (after: number, limit = 100) => repository.events(after, limit),
  };
}

export type PeerBoard = ReturnType<typeof createPeerBoard>;
