import { createHash } from "node:crypto";
import type { DeliveryProvenance, Destination, OutgoingAttachment, ScopeId } from "../types.ts";
import type { TurnOrigin } from "../core/turn-origin.ts";
import { acquireLeaseWithin, type SessionStore } from "../sessions/session-store.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import type { IdempotencyStore } from "../idempotency/idempotency-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { errMessage, reportFailure } from "../util/errors.ts";

export interface OutboundPost {
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
  provenance?: DeliveryProvenance;
  createdAt?: number;
  retry?: boolean;
}

export interface PostReceipt {
  recipientThreadRef?: string;
  deferred?: boolean;
  queued?: boolean;
}

export type SurfaceSender = (post: OutboundPost) => Promise<PostReceipt | void>;

export interface Outbound {
  send(post: OutboundPost): Promise<PostReceipt | void>;
  register(types: readonly string[], sender: SurfaceSender): () => void;
  retryQueued(now?: number): Promise<number>;
}

export interface QueuedPost {
  post: OutboundPost;
  firstFailedAt: number;
  lastError: string;
}

const RETRY_MAX_AGE_MS = 6 * 60 * 60_000;
const isPermanent = (error: unknown): boolean => (error as { permanent?: boolean } | null)?.permanent === true;

const DEFERRED = new Error("deferred to a live turn handler");

export function createOutbound(opts: {
  idempotency?: Pick<IdempotencyStore, "once">;
  retries?: DurableMap<QueuedPost>;
  afterSend?: (post: OutboundPost, receipt: PostReceipt) => void;
}): Outbound {
  const senders = new Map<string, SurfaceSender[]>();
  const senderFor = (type: string): SurfaceSender | undefined => senders.get(type)?.at(-1);
  const once =
    opts.idempotency?.once.bind(opts.idempotency) ?? (async (_: string, fn: () => Promise<void>) => (await fn(), true));
  const retryable = (post: OutboundPost, error: unknown): boolean =>
    Boolean(opts.retries) && post.destination.type !== "web" && !isPermanent(error);
  return {
    async send(post) {
      const sender = senderFor(post.destination.type);
      if (!sender && !retryable(post, null))
        throw new Error(`no ${post.destination.type} connection is available to post this message`);
      let receipt: PostReceipt = {};
      let posted = false;
      try {
        await once(`post:${post.idempotencyKey}`, async () => {
          try {
            if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
            receipt = (await sender(post)) ?? {};
          } catch (error) {
            if (!retryable(post, error)) throw error;
            const now = Date.now();
            await opts.retries!.put(post.idempotencyKey, {
              post,
              firstFailedAt: now,
              lastError: errMessage(error),
            });
            reportFailure("outbound: post failed, queued for retry", error, `key=${post.idempotencyKey}`);
            receipt = { queued: true };
            return;
          }
          if (receipt.deferred) throw DEFERRED;
          posted = true;
        });
      } catch (error) {
        if (error === DEFERRED) return { deferred: true };
        throw error;
      }
      if (posted) opts.afterSend?.(post, receipt);
      return receipt;
    },
    register(types, sender) {
      for (const type of types) senders.set(type, [...(senders.get(type) ?? []), sender]);
      return () => {
        for (const type of types)
          senders.set(
            type,
            (senders.get(type) ?? []).filter((s) => s !== sender),
          );
      };
    },
    async retryQueued(now = Date.now()) {
      if (!opts.retries) return 0;
      let sent = 0;
      for (const [key, queued] of await opts.retries.entries()) {
        const { post } = queued;
        if (now - queued.firstFailedAt > RETRY_MAX_AGE_MS) {
          await opts.retries.delete(key);
          reportFailure("outbound: gave up on a queued post", new Error(queued.lastError), `key=${key}`);
          continue;
        }
        const sender = senderFor(post.destination.type);
        try {
          if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
          const receipt =
            (await sender({ ...post, retry: true, createdAt: post.createdAt ?? queued.firstFailedAt })) ?? {};
          if (receipt.deferred) continue;
          await opts.retries.delete(key);
          console.error(
            `[outbound] queued post ${key} went out ${Math.round((now - queued.firstFailedAt) / 1000)}s after it first failed (${queued.lastError})`,
          );
          opts.afterSend?.(post, receipt);
          sent += 1;
        } catch (error) {
          if (isPermanent(error)) {
            await opts.retries.delete(key);
            reportFailure("outbound: queued post refused (not retried)", error, `key=${key}`);
            continue;
          }
          await opts.retries.put(key, { ...queued, lastError: errMessage(error) });
        }
      }
      return sent;
    },
  };
}

export function turnPostProvenance(input: {
  origin: Pick<TurnOrigin, "kind">;
  surface: string | undefined;
  fireKey: string;
  sourceScopeId: ScopeId;
  sourceThreadRef: string;
  sourceSessionId?: string;
  sourceUserSeq?: number;
  sourceAssistantEntrySeq?: number;
}): DeliveryProvenance {
  return {
    trigger: input.origin.kind === "automation" ? (input.surface ?? "wake") : "conversation",
    surface: input.surface ?? "unknown",
    fireKey: input.fireKey,
    sourceScopeId: input.sourceScopeId,
    sourceThreadRef: input.sourceThreadRef,
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.sourceUserSeq !== undefined ? { sourceUserSeq: input.sourceUserSeq } : {}),
    ...(input.sourceAssistantEntrySeq !== undefined ? { sourceAssistantEntrySeq: input.sourceAssistantEntrySeq } : {}),
  };
}

const TRANSCRIPT_LEASE_WAIT_MS = 2 * 60_000;

function keyTurnId(key: string): string {
  const h = createHash("sha256").update(`outbound:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type TranscriptSessions = Pick<
  SessionStore,
  "getByThread" | "acquireLease" | "peekLease" | "releaseLease" | "appendMany" | "getEntries" | "participantsOf"
>;

interface TranscriptDeps {
  sessions: TranscriptSessions;
  sessionStates?: SessionStateBus;
  leaseWaitMs?: number;
}

export async function appendToTranscript(
  deps: TranscriptDeps,
  session: { id: string; threadRef: string; scopeId: ScopeId },
  entry: { type: "assistant" | "user"; payload: Record<string, unknown> },
  key: string,
  alreadyThere?: () => Promise<boolean>,
): Promise<void> {
  const wait = deps.leaseWaitMs ?? TRANSCRIPT_LEASE_WAIT_MS;
  const { lease } = await acquireLeaseWithin(deps.sessions, session.id, "backfill", wait);
  if (!lease)
    throw Object.assign(
      new Error("that conversation stayed busy, so the message was not added to it — try again shortly"),
      { busy: true },
    );
  const turnId = keyTurnId(key);
  try {
    const present = alreadyThere
      ? await alreadyThere()
      : (await deps.sessions.getEntries(session.id, { turnId })).some((e) => e.type === entry.type);
    if (present) return;
    await deps.sessions.appendMany({ ...lease, turnId }, [{ ...entry, scopeLabel: session.scopeId }]);
  } finally {
    await deps.sessions.releaseLease(lease);
  }
  const participants = await deps.sessions.participantsOf(session.id).catch(() => []);
  deps.sessionStates?.emit({
    threadRef: session.threadRef,
    sessionId: session.id,
    state: "idle",
    at: Date.now(),
    ...(participants.length ? { participants } : {}),
  });
}

export function createWebSender(deps: {
  sessions: TranscriptSessions;
  sessionStates?: SessionStateBus;
}): SurfaceSender {
  return async (post) => {
    const { destination: dest, provenance } = post;
    const fromElsewhere = provenance !== undefined && provenance.sourceThreadRef !== dest.target;
    if (!post.text.trim() || (dest.webTranscript?.kind !== "reply" && !fromElsewhere)) return;
    const session = await deps.sessions.getByThread(dest.target);
    if (!session) throw new Error(`web conversation ${dest.target} does not exist`);
    await appendToTranscript(deps, session, { type: "assistant", payload: { text: post.text } }, post.idempotencyKey);
  };
}
