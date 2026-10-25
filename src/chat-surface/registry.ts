import type { IncomingHttpHeaders } from "node:http";
import type { App } from "../api/app.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { ActorAssertion, Delivery, TurnRequest } from "../types.ts";
import { destinationSource } from "../types.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import type { ChatSurfaceAdapter, InboundMessage, SurfaceUser } from "./adapter.ts";
import { parseSurfaceDeliveryTarget, surfaceContainerRef, surfaceDeliveryTarget, surfaceThreadRef } from "./refs.ts";

export interface SurfaceCore {
  turn: App["turn"];
  claimDeliveries(type: string, claimMs: number): Promise<Delivery[]>;
  ackDelivery(id: string): Promise<void>;
  onDeliveryEnqueued(listener: () => void): () => void;
  hold: LeaderLease["hold"];
}

export interface SurfaceRegistry {
  label(surface: string): string | undefined;
  receive(
    surface: string,
    request: { headers: IncomingHttpHeaders; pathWithQuery: string; rawBody: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  start(): void;
  stop(): Promise<void>;
  drain(surface: string): Promise<number>;
}

const DELIVERY_CLAIM_MS = 60_000;
const DELIVERY_SWEEP_MS = 5_000;

function actorFor(adapter: ChatSurfaceAdapter, user: SurfaceUser): ActorAssertion {
  return {
    externalId: user.email?.trim() || `${adapter.surface}:${adapter.account}:user:${user.id}`,
    ...(user.guest ? { isExternalGuest: true } : {}),
    ...(user.bot ? { isBot: true } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
  };
}

export function inboundTurn(adapter: ChatSurfaceAdapter, message: InboundMessage): TurnRequest | undefined {
  if (message.author.bot) return undefined;
  if (message.kind !== "dm" && !message.mentionsSelf && !message.threadEngaged) return undefined;
  const actor = actorFor(adapter, message.author);
  const ref = {
    surface: adapter.surface,
    account: adapter.account,
    kind: message.kind,
    container: message.container,
    ...(message.thread ? { thread: message.thread } : {}),
  };
  return {
    surface: adapter.surface,
    source: {
      account: adapter.account,
      workspaceId: adapter.account,
      userId: message.author.id,
      ...(message.thread ? { replyThread: message.thread } : {}),
    },
    actor,
    conversation: {
      kind: message.kind,
      threadRef: surfaceThreadRef(ref),
      ...(message.kind === "dm" ? {} : { channelRef: surfaceContainerRef(ref) }),
      ...(message.containerName ? { channelName: message.containerName } : {}),
      audience: (message.members?.length ? message.members : [message.author]).map((user) => actorFor(adapter, user)),
      isPrivate: message.kind !== "channel",
    },
    text: message.text,
    deliveryTarget: surfaceDeliveryTarget(ref),
    idempotencyKey: `${adapter.surface}:${adapter.account}:${message.messageId}`,
    addressed: true,
    liveActor: true,
    ...(message.author.timezone ? { timezone: message.author.timezone } : {}),
    async: true,
  };
}

export function createSurfaceRegistry(adapters: readonly ChatSurfaceAdapter[], core: SurfaceCore): SurfaceRegistry {
  const bySurface = new Map(adapters.map((adapter) => [adapter.surface, adapter]));
  if (bySurface.size !== adapters.length) throw new Error("chat surface names must be unique");
  const stops: Array<() => void> = [];

  async function deliver(adapter: ChatSurfaceAdapter, delivery: Delivery): Promise<void> {
    const account = destinationSource(delivery.destination).account;
    const target = parseSurfaceDeliveryTarget(delivery.destination.target);
    if ((account !== undefined && account !== adapter.account) || !target || !delivery.text.trim()) {
      console.error(`[chat-surface] ${adapter.surface}: dropping undeliverable delivery ${delivery.id}`);
      await core.ackDelivery(delivery.id);
      return;
    }
    await adapter.post(target, { text: delivery.text, idempotencyKey: delivery.idempotencyKey });
    await core.ackDelivery(delivery.id);
  }

  async function drain(surface: string): Promise<number> {
    const adapter = bySurface.get(surface);
    if (!adapter) return 0;
    const delivered = await core.hold(`chat-surface:${surface}:deliveries`, async () => {
      let count = 0;
      for (const delivery of await core.claimDeliveries(surface, DELIVERY_CLAIM_MS)) {
        try {
          await deliver(adapter, delivery);
          count += 1;
        } catch (error) {
          console.error(`[chat-surface] ${surface}: delivery ${delivery.id} failed: ${errMessage(error)}`);
        }
      }
      return count;
    });
    return delivered ?? 0;
  }

  return {
    label: (surface) => bySurface.get(surface)?.label,
    async receive(surface, request) {
      const adapter = bySurface.get(surface);
      if (!adapter) return { status: 404, body: { error: "not_found" } };
      const outcome = await adapter.receive(request);
      if (outcome.status !== 200) return { status: outcome.status, body: { error: outcome.reason } };
      const runs: string[] = [];
      for (const message of outcome.messages) {
        const turn = inboundTurn(adapter, message);
        if (!turn) continue;
        const result = await core.turn(turn);
        if (result.runId) runs.push(result.runId);
      }
      return { status: 200, body: { ok: true, runs } };
    },
    start() {
      if (stops.length) return;
      for (const surface of bySurface.keys()) {
        const kick = (): void => void drain(surface).catch(reportFailureAs("chat-surface: delivery drain", undefined));
        const timer = setInterval(kick, DELIVERY_SWEEP_MS);
        const unsubscribe = core.onDeliveryEnqueued(kick);
        stops.push(() => {
          clearInterval(timer);
          unsubscribe();
        });
        kick();
      }
    },
    async stop() {
      for (const stop of stops.splice(0)) stop();
    },
    drain,
  };
}
