import type { StoresModule } from "./stores.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { RunsModule } from "./runs.ts";
import type { Head } from "./late.ts";
import { createIdempotencyStore } from "../idempotency/idempotency-store.ts";
import { createRecentDmPosts } from "../surfaces/recent-dm-posts.ts";
import { createQueuedPosts } from "../surfaces/queued-posts.ts";
import { createOutbound, createWebSurface } from "../surfaces/outbound.ts";
import { scopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { createSlackSurface } from "../surfaces/slack-surface.ts";
import { createSurfaceRegistry } from "../surfaces/registry.ts";
import { createHttpChatSurface } from "../surfaces/http-chat.ts";

type OutboundInputs = Pick<Head, "config" | "late"> & { stores: StoresModule; runs: RunsModule };

export function buildOutbound(deps: OutboundInputs) {
  const { databaseUrl, sessions, every } = deps.stores;
  const { sessionStateBus } = deps.runs;
  const { config, late } = deps;

  const idempotency = createIdempotencyStore(databaseUrl);
  const transcripts = { sessions, sessionStates: sessionStateBus };
  const recentDmPosts = createRecentDmPosts(databaseUrl);
  const outbound = createOutbound({
    idempotency,
    retries: createQueuedPosts(databaseUrl),
    afterSend: (post, receipt) => {
      const recipientId = post.destination.target;
      const threadRef = receipt.recipientThreadRef;
      if (post.destination.type !== "principal" || !threadRef) return;
      void (async () => {
        const session = await sessions.getOrCreateByThread(
          threadRef,
          "dm",
          scopeId("personal", recipientId),
          undefined,
          "slack",
        );
        await sessions.addParticipant(session.id, recipientId);
        await recentDmPosts.remember(threadRef, {
          key: post.idempotencyKey,
          text: post.text,
          at: Date.now(),
          ...(post.destination.onBehalfOf ? { onBehalfOf: post.destination.onBehalfOf } : {}),
          ...(post.provenance?.trigger ? { trigger: post.provenance.trigger } : {}),
        });
      })().catch(swallowAs("outbound: remember DM post", undefined));
    },
  });
  const slackSurface = createSlackSurface();
  const chatSurfaces = createSurfaceRegistry({
    surfaces: [
      createWebSurface(transcripts),
      slackSurface,
      ...(config.chatSurfaces ?? []).map((surface) =>
        createHttpChatSurface(surface, { mirror: (events) => late.app.ingestSurfaceEvents(events, surface.surface) }),
      ),
    ],
    outbound,
    turn: (request) => late.app.turn(request),
  });
  every("queued-post-retry", 30_000, () => outbound.retryQueued(), { due: hasRows("queued_posts") });
  return { outbound, chatSurfaces, recentDmPosts, slackSurface, idempotency };
}

export type OutboundModule = ReturnType<typeof buildOutbound>;
