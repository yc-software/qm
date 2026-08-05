import { swallow, swallowAs } from "../util/errors.ts";
import { WebClient } from "@slack/web-api";
import {
  type RecentMessage,
  type SlackFile,
  buildContextWindow,
  downloadSlackFile,
  isExternallyShared,
  isOversize,
  openConversationFor,
  oversizeMsg,
  parseDeliveryTarget,
} from "./lib.ts";
import type { SlackCoreClient, SurfaceContextRequest } from "../api/slack-core-client.ts";
import type { CoreBridge } from "./core-bridge.ts";
import type { Directory } from "./directory.ts";
import {
  type ConversationSerializer,
  RECENT_HISTORY_LIMIT,
  RECENT_THREAD_LIMIT,
  slackFileName,
} from "./conversation-view.ts";

export function createSurfaceContextFulfiller(deps: {
  core: SlackCoreClient;
  bridge: CoreBridge;
  directory: Directory;
  serializer: ConversationSerializer;
  botToken: string;
  trustedFileHost?: string;
  userToken?: string;
  clientOptions: Record<string, unknown>;
}): { fulfillSurfaceContext(client: any, r: SurfaceContextRequest): Promise<void> } {
  const { core, bridge, directory, serializer, botToken, trustedFileHost, userToken, clientOptions } = deps;

  async function fulfillLiveSearch(
    query: string,
    count: number,
    post: (body: unknown) => Promise<void>,
    viewerToken?: string,
  ): Promise<void> {
    const token = viewerToken || userToken;
    if (!token) {
      await post({ messages: [], note: "live-search-unconnected" });
      return;
    }
    try {
      const userClient = new WebClient(token, { ...clientOptions });
      const res = (await userClient.search.messages({ query, count: Math.min(count, 100) })) as any;
      const matches: any[] = res?.messages?.matches ?? [];
      const shaped: RecentMessage[] = matches
        .map((m) => ({
          ts: String(m?.ts ?? ""),
          name: String(m?.username || m?.user || "someone"),
          text: String(m?.text ?? ""),
          ...(m?.user ? { authorId: String(m.user) } : {}),
        }))
        .filter((m) => m.ts);
      await post(buildContextWindow(shaped, { count }));
    } catch (err) {
      const msg = (err as Error).message;
      if (viewerToken && /invalid_auth|token_revoked|account_inactive|token_expired/.test(msg)) {
        await post({ messages: [], note: "live-search-unconnected" });
        return;
      }
      await post({ error: `Slack search failed: ${msg}` });
    }
  }

  async function fetchContextHistory(
    client: any,
    channel: string,
    threadTs: string | undefined,
    before: string | undefined,
  ): Promise<{ raw: any[]; hasMore: boolean }> {
    const page = before ? { latest: before, inclusive: false } : {};
    if (threadTs) {
      const res = await client.conversations.replies({ channel, ts: threadTs, limit: RECENT_THREAD_LIMIT, ...page });
      return { raw: res.messages ?? [], hasMore: Boolean(res.has_more) };
    }
    const res = await client.conversations.history({ channel, limit: RECENT_HISTORY_LIMIT, ...page });
    return { raw: ((res.messages ?? []) as any[]).slice().reverse(), hasMore: Boolean(res.has_more) };
  }

  async function findMessageAt(
    client: any,
    channel: string,
    ts: string,
    threadTs: string | undefined,
  ): Promise<any | undefined> {
    if (threadTs) {
      const res = await client.conversations.replies({ channel, ts: threadTs, oldest: ts, inclusive: true, limit: 2 });
      const hit = ((res.messages ?? []) as any[]).find((m) => m?.ts === ts);
      if (hit) return hit;
    }
    const res = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
    const hit = ((res.messages ?? []) as any[]).find((m) => m?.ts === ts);
    return hit;
  }

  async function fetchSurfaceFile(
    client: any,
    channel: string,
    conversationThreadTs: string | undefined,
    ref: { ts: string; threadTs?: string; name?: string },
  ): Promise<Record<string, unknown>> {
    const threadTs = typeof ref.threadTs === "string" && ref.threadTs ? ref.threadTs : conversationThreadTs;
    const msg = await findMessageAt(client, channel, ref.ts, threadTs);
    if (!msg) {
      return {
        error: "I couldn't find that message — if it's a thread reply, pass its threadTs (the parent message's ts) too",
      };
    }
    const files = ((msg.files ?? []) as SlackFile[]).filter((f) => f?.id);
    if (!files.length) return { error: "that message has no files attached" };
    let file: SlackFile | undefined;
    if (ref.name) {
      const want = ref.name.toLowerCase();
      file =
        files.find((f) => slackFileName(f).toLowerCase() === want) ??
        files.find((f) => slackFileName(f).toLowerCase().includes(want));
      if (!file)
        return {
          error: `that message has no file matching "${ref.name}" — it carries: ${files.map(slackFileName).join(", ")}`,
        };
    } else if (files.length === 1) {
      file = files[0]!;
    } else {
      return {
        error: `that message carries ${files.length} files — pass a name: ${files.map(slackFileName).join(", ")}`,
      };
    }
    if (isOversize(file)) return { error: oversizeMsg(slackFileName(file)) };
    let bytes: Uint8Array;
    let blobId: string;
    try {
      bytes = await downloadSlackFile(file, {
        token: botToken,
        ...(trustedFileHost ? { trustedHost: trustedFileHost } : {}),
      });
      ({ blobId } = await bridge.stageBlobInCore(bytes));
    } catch (err) {
      swallow("slack: surface-file fetch", err);
      return { error: `I couldn't read "${slackFileName(file)}" — it may be restricted, deleted, or too large for me` };
    }
    const author = file.user
      ? await directory.classifyUserCached(client, file.user).then(
          (c) => c.actor.displayName,
          () => undefined,
        )
      : undefined;
    return {
      file: {
        blobId,
        name: slackFileName(file),
        sizeBytes: bytes.length,
        ...(file.mimetype ? { mimetype: file.mimetype } : {}),
        ...(author ? { author } : {}),
      },
    };
  }

  async function openGroupDm(client: any, participants: readonly string[]): Promise<Record<string, unknown>> {
    const people = [...new Set(participants.filter(Boolean))];
    if (people.length < 2) return { error: "a group DM needs at least two people besides me" };
    let groupId: string;
    try {
      groupId = await openConversationFor(client, people);
    } catch (err) {
      const code = (err as any)?.data?.error;
      if (code === "method_not_supported_for_channel_type" || code === "missing_scope")
        return { error: "I'm not allowed to open group DMs in this workspace (the app needs the mpim:write scope)" };
      return { error: `I couldn't open that group DM: ${(err as Error).message}` };
    }
    try {
      void directory.forceDirectorySync(client).catch(swallowAs("slack: sync after opening a group DM", undefined));
    } catch (err) {
      swallow("slack: sync after opening a group DM", err);
    }
    return { group: { groupId } };
  }

  async function fulfillSurfaceContext(client: any, r: SurfaceContextRequest): Promise<void> {
    const post = async (body: unknown): Promise<void> => {
      const { error, ...rest } = (body ?? {}) as { error?: string; messages?: unknown[] } & Record<string, unknown>;
      await core.fulfillContextRequest(
        r.id,
        typeof error === "string" ? { error } : { result: { ...rest, messages: rest.messages ?? [] } },
      );
    };
    try {
      const q = r.query ?? {};
      if (q.syncDirectory) {
        await directory.forceDirectorySync(client).catch(swallowAs("slack: on-demand directory sync", undefined));
        return await post({ messages: [] });
      }
      if (q.openGroup) return await post(await openGroupDm(client, q.openGroup.participants ?? []));
      if (typeof q.searchAll === "string" && q.searchAll) {
        return fulfillLiveSearch(
          q.searchAll,
          Math.max(1, Math.min(RECENT_THREAD_LIMIT, Number(q.count) || 100)),
          post,
          typeof q.viewerToken === "string" && q.viewerToken ? q.viewerToken : undefined,
        );
      }
      let channel: string;
      let threadTs: string | undefined;
      if (typeof q.conversationTarget === "string" && q.conversationTarget) {
        ({ channel, threadTs } = parseDeliveryTarget(q.conversationTarget));
      } else if (typeof q.channelId === "string" && q.channelId) {
        channel = q.channelId;
        const info = await directory.getChannelInfo(client, channel);
        if (!info) return post({ error: "I can't see that channel" });
        if (isExternallyShared(info)) return post({ error: "that channel is externally shared, so I won't read it" });
        if ((info as any).is_member === false)
          return post({ error: "I'm not a member of that channel — ask someone to /invite me there" });
      } else {
        return post({ error: "malformed context request" });
      }
      if (q.file && typeof q.file.ts === "string" && q.file.ts) {
        return await post(await fetchSurfaceFile(client, channel, threadTs, q.file));
      }
      const count = Math.max(1, Math.min(RECENT_THREAD_LIMIT, Number(q.count) || 100));
      const before = typeof q.before === "string" && q.before ? q.before : undefined;
      const [chanPage, threadPage] = await Promise.all([
        fetchContextHistory(client, channel, undefined, before),
        threadTs
          ? fetchContextHistory(client, channel, threadTs, before)
          : Promise.resolve({ raw: [] as any[], hasMore: false }),
      ]);
      const byTs = new Map<string, any>();
      for (const m of [...chanPage.raw, ...threadPage.raw]) if (m?.ts) byTs.set(m.ts, m);
      const raw = [...byTs.values()];
      const hasMore = chanPage.hasMore || threadPage.hasMore;
      const nameById = new Map<string, string>();
      const shaped = await serializer.shapeRecentMessages(client, raw, "", nameById);
      await post(
        buildContextWindow(shaped, {
          count,
          ...(typeof q.match === "string" && q.match ? { match: q.match } : {}),
          scanHasMore: hasMore,
          nameById,
        }),
      );
    } catch (err) {
      const code = (err as any)?.data?.error;
      let msg = `Slack read failed: ${(err as Error).message}`;
      if (code === "not_in_channel") msg = "I'm not a member of that channel — ask someone to /invite me there";
      else if (code === "channel_not_found") msg = "I can't see that channel";
      await post({ error: msg });
    }
  }

  return { fulfillSurfaceContext };
}
