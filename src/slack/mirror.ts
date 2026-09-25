import { swallow } from "../util/errors.ts";
import { decodeSlackEntities, mentionsBot } from "./lib.ts";
import { messageWithForwardedContent } from "./forwards.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { IngestEvent } from "../surface-cache/surface-cache.ts";
import type { BotIdentity, Directory } from "./directory.ts";
import type { SlackMessageEvent } from "./payloads.ts";
import { MAX_NAME_LOOKUPS } from "./conversation-view.ts";

export interface Mirror {
  pushSurfaceEvents(events: IngestEvent[]): Promise<void>;
  mirrorMessageEvent(
    m: Partial<SlackMessageEvent>,
    client: any,
    opts?: {
      partial?: boolean;
      editedAt?: number;
      handled?: boolean;
      containerName?: string;
      kind?: "channel" | "dm" | "group";
    },
  ): Promise<void>;
}

export function slackMessageToIngestEvent(
  m: Partial<SlackMessageEvent>,
  ids: BotIdentity,
  opts: {
    partial?: boolean;
    text?: string;
    mentions?: Record<string, string>;
    editedAt?: number;
    handled?: boolean;
    containerName?: string;
    kind?: "channel" | "dm" | "group";
  } = {},
): IngestEvent {
  const content = messageWithForwardedContent(m);
  const raw = content.text;
  return {
    container: m.channel!,
    ts: m.ts!,
    ...(m.subtype !== undefined || !opts.partial
      ? { subtype: m.subtype ?? "", broadcast: m.subtype === "thread_broadcast" }
      : {}),
    ...(m.subtype === "tombstone" ? { deleted: true } : {}),
    ...(m.thread_ts !== undefined || !opts.partial
      ? { sub: m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : null }
      : {}),
    ...(m.bot_id ? { botId: String(m.bot_id) } : {}),
    ...(m.user ? { authorId: String(m.user) } : {}),
    ...(m.bot_profile?.name || m.username ? { authorName: String(m.bot_profile?.name || m.username) } : {}),
    text: opts.text ?? decodeSlackEntities(raw),
    ...((ids.botUserId && m.user === ids.botUserId) || (ids.ownBotId && m.bot_id === ids.ownBotId)
      ? { self: true, handled: true }
      : {}),
    files: content.files
      .filter((file) => file.id)
      .map((file) => ({
        fileId: file.id!,
        name: file.name,
        ...(file.title !== undefined ? { title: file.title } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
        mimetype: file.mimetype,
      })),
    ...(Object.keys(opts.mentions ?? {}).length ? { mentions: opts.mentions } : {}),
    ...(m.bot_id || m.bot_profile ? { bot: true } : {}),
    ...(mentionsBot(raw, ids.botUserId) ? { mentionsSelf: true } : {}),
    ...((opts.editedAt ?? Number(m.edited?.ts) * 1000) > 0
      ? { editedAt: Math.round(opts.editedAt ?? Number(m.edited?.ts) * 1000) }
      : {}),
    ...(opts.handled ? { handled: true } : {}),
    ...(opts.containerName ? { containerName: opts.containerName } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
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
    await core.ingestSurfaceEvents(events, { name: ids.botHandle, mentionId: ids.botUserId });
  }

  async function resolveMentionNames(client: any, text: string): Promise<Record<string, string>> {
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
    return Object.fromEntries(names);
  }

  async function mirrorMessageEvent(
    m: Partial<SlackMessageEvent>,
    client: any,
    opts: {
      partial?: boolean;
      editedAt?: number;
      handled?: boolean;
      containerName?: string;
      kind?: "channel" | "dm" | "group";
    } = {},
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
        if (kind !== "group" && !info) throw new Error("Slack mirror room lookup unavailable");
        const rosters = await directory.allInternalRosters(client, [{ id: container, ...(info ? { info } : {}) }], {
          plural: "ambient rooms",
          authz: "ambient-work",
          item: "room",
          requireComplete: true,
        });
        gate = { allowed: rosters.has(container), at: Date.now() };
        ambientRoomGate.set(container, gate);
      }
      if (!gate.allowed) return;
    }
    const content = messageWithForwardedContent(m);
    const raw = content.text;
    const mentions = await resolveMentionNames(client, decodeSlackEntities(raw));
    await pushSurfaceEvents([slackMessageToIngestEvent(m, ids, { ...opts, mentions, kind })]);
  }

  return { pushSurfaceEvents, mirrorMessageEvent };
}
