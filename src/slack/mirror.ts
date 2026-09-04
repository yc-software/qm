import { swallow } from "../util/errors.ts";
import { decodeSlackEntities, mentionsBot, resolveMentionsInText } from "./lib.ts";
import { messageWithForwardedContent } from "./forwards.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { IngestEvent } from "../surface-cache/surface-cache.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import { MAX_NAME_LOOKUPS } from "./conversation-view.ts";

export interface Mirror {
  pushSurfaceEvents(events: IngestEvent[]): Promise<void>;
  mirrorSelfPost(
    container: string,
    ts: unknown,
    text: string,
    opts?: { sub?: string; editedAt?: number; kind?: "channel" | "dm" | "group" },
  ): void;
  resolveTextMentions(client: any, text: string): Promise<{ text: string; mentions: Record<string, string> }>;
  mirrorMessageEvent(
    m: any,
    client: any,
    opts?: { editedAt?: number; handled?: boolean; containerName?: string; kind?: "channel" | "dm" | "group" },
  ): Promise<void>;
}

export function createMirror(deps: {
  core: SlackCoreClient;
  ids: BotIdentity;
  directory: Directory;
  externalParticipantsEnabled(): Promise<boolean>;
}): Mirror {
  const { core, ids, directory, externalParticipantsEnabled } = deps;
  const ambientRoomGate = new Map<string, { allowed: boolean; at: number }>();

  async function pushSurfaceEvents(events: IngestEvent[]): Promise<void> {
    if (!events.length) return;
    try {
      await core.ingestSurfaceEvents(events, { name: ids.botHandle, mentionId: ids.botUserId });
    } catch (e) {
      swallow("slack: surface-cache ingest", e);
    }
  }

  function mirrorSelfPost(
    container: string,
    ts: unknown,
    text: string,
    opts: { sub?: string; editedAt?: number; kind?: "channel" | "dm" | "group" } = {},
  ): void {
    if (!ts) return;
    void pushSurfaceEvents([
      {
        container,
        ts: String(ts),
        ...(opts.sub ? { sub: opts.sub } : {}),
        self: true,
        text,
        ...(opts.editedAt ? { editedAt: opts.editedAt } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
      },
    ]);
  }

  async function resolveTextMentions(
    client: any,
    text: string,
  ): Promise<{ text: string; mentions: Record<string, string> }> {
    const mentionIds = new Set<string>();
    for (const match of text.matchAll(/<@(U\w+)(?:\|[^>]*)?>/g)) mentionIds.add(match[1] as string);
    const names = new Map<string, string>();
    await Promise.all(
      [...mentionIds].slice(0, MAX_NAME_LOOKUPS).map(async (id) => {
        try {
          const dn = (await directory.classifyUserCached(client, id)).actor.displayName;
          if (dn) names.set(id, dn);
        } catch (e) {
          swallow("slack: mention users.info", e);
        }
      }),
    );
    return { text: resolveMentionsInText(text, (id) => names.get(id)), mentions: Object.fromEntries(names) };
  }

  async function mirrorMessageEvent(
    m: any,
    client: any,
    opts: { editedAt?: number; handled?: boolean; containerName?: string; kind?: "channel" | "dm" | "group" } = {},
  ): Promise<void> {
    const container = m.channel;
    const ts = m.ts;
    if (!container || !ts) return;
    const type = m.channel_type;
    if (!opts.kind && type !== "channel" && type !== "group" && type !== "mpim") return;
    const kind = opts.kind ?? (type === "mpim" ? "group" : "channel");
    if (!(await externalParticipantsEnabled())) {
      let gate = ambientRoomGate.get(container);
      if (!gate || Date.now() - gate.at > 5_000) {
        const info = kind === "group" ? undefined : await directory.getChannelInfo(client, container);
        const rosters = await directory.allInternalRosters(client, [{ id: container, ...(info ? { info } : {}) }], {
          plural: "ambient rooms",
          authz: "ambient-work",
          item: "room",
        });
        gate = { allowed: rosters.has(container), at: Date.now() };
        ambientRoomGate.set(container, gate);
      }
      if (!gate.allowed) return;
    }
    const raw = messageWithForwardedContent(m).text;
    const { text, mentions } = await resolveTextMentions(client, decodeSlackEntities(raw));
    await pushSurfaceEvents([
      {
        container,
        ts,
        ...(m.thread_ts && m.thread_ts !== ts ? { sub: String(m.thread_ts) } : {}),
        ...(m.user ? { authorId: String(m.user) } : {}),
        ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
        text,
        ...(Object.keys(mentions).length ? { mentions } : {}),
        ...(m.bot_id || m.bot_profile ? { bot: true } : {}),
        ...(mentionsBot(raw, ids.botUserId) ? { mentionsSelf: true } : {}),
        ...(opts.editedAt ? { editedAt: opts.editedAt } : {}),
        ...(opts.handled ? { handled: true } : {}),
        ...(opts.containerName ? { containerName: opts.containerName } : {}),
        kind,
      },
    ]);
  }

  return { pushSurfaceEvents, mirrorSelfPost, resolveTextMentions, mirrorMessageEvent };
}
