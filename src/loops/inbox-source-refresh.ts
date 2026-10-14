import { LRUCache } from "lru-cache";
import { personalScope, type LoopItem } from "../types.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import { redactSecrets } from "../harness/redact-secrets.ts";
import { errMessage } from "../util/errors.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { isResolved } from "./ledger-view.ts";
import { isObj, tokenFor, type ConnectorTokenSource } from "./sources/adapter.ts";
import { normalizeSlackApiUrl } from "../slack/config.ts";

interface RefreshDeps {
  items: LoopItemLedger;
  tokens: ConnectorTokenSource;
  featureFlags: Pick<FeatureFlagStore, "enabled">;
  errors?: ErrorLog;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
  now?: () => number;
}

export type InboxSourceRefresh = (owner: string, items: LoopItem[], mode?: "avatars") => Promise<void>;

interface SlackParticipant {
  id: string;
  name: string;
  avatarUrl?: string;
}

// Reuse the inbox's existing refresh cycle, not a second provider poller. Cache only
// results/identities, never credentials, and share in-flight reads between tabs.
export function createInboxSourceRefresh(deps: RefreshDeps): InboxSourceRefresh {
  const checked = new LRUCache<string, boolean>({ max: 2000, ttl: 60_000 });
  const info = new LRUCache<string, Record<string, unknown>>({ max: 2000, ttl: 300_000 });
  const limited = new LRUCache<string, boolean>({ max: 2000 });
  const running = new Map<string, Promise<void>>();
  const infoRunning = new Map<string, Promise<Record<string, unknown>>>();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const positions = new LRUCache<string, number>({ max: 2000 });
  const slackBase = normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api");

  function recordFailure(owner: string, subject: string, error: unknown): void {
    deps.errors?.record({
      category: "inbox",
      code: "source_refresh_failed",
      message: redactSecrets(`${subject}: ${errMessage(error)}`),
      scopeLabel: personalScope(owner),
    });
  }

  async function get(
    owner: string,
    source: string,
    path: string,
    token: string,
    deadline = now() + 3000,
  ): Promise<Record<string, unknown>> {
    const method = path.split("?")[0]!;
    const key = `${owner}:${source}:${source === "slack" ? method : "read"}`;
    if (limited.has(key)) throw new Error("Source rate limited. The next refresh will retry.");
    const base = source === "slack" ? slackBase : "https://gmail.googleapis.com/gmail/v1/users/me/";
    const res = await fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - now()))),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      limited.set(key, true, { ttl: Math.max(60, Number.isFinite(retry) ? retry : 60) * 1000 });
    }
    if (!res.ok)
      throw new Error("Couldn't refresh the source. Your item has not been dismissed.", {
        cause: new Error(`${source} ${method}: HTTP ${res.status}`),
      });
    const body: unknown = await res.json();
    if (!isObj(body) || body.ok === false)
      throw new Error("Couldn't refresh the source. Your item has not been dismissed.", {
        cause: new Error(
          `${source} ${method}: ${isObj(body) && typeof body.error === "string" ? body.error : "Invalid response"}`,
        ),
      });
    return body;
  }

  async function slackInfo(
    owner: string,
    path: string,
    token: string,
    deadline?: number,
  ): Promise<Record<string, unknown>> {
    const key = `${owner}:${path}`;
    const cached = info.get(key);
    if (cached) return cached;
    const pending = infoRunning.get(key);
    if (pending) return pending;
    const task = get(owner, "slack", path, token, deadline)
      .then((value) => {
        info.set(key, value);
        return value;
      })
      .finally(() => infoRunning.delete(key));
    infoRunning.set(key, task);
    return task;
  }

  function imageUrl(profile: Record<string, unknown>): string | undefined {
    return [48, 72, 192, 512, 1024, 32, 24, "original", 36, 96, 128, 256]
      .map((size) => profile[`image_${size}`])
      .find((value): value is string => typeof value === "string" && value.startsWith("https://"));
  }

  function savedParticipants(payload: Record<string, unknown>): SlackParticipant[] {
    return Array.isArray(payload.participants)
      ? payload.participants.filter(
          (person): person is SlackParticipant =>
            isObj(person) && typeof person.id === "string" && typeof person.name === "string",
        )
      : [];
  }

  function messageParticipant(message: Record<string, unknown>): SlackParticipant | undefined {
    const bot = isObj(message.bot_profile) ? message.bot_profile : {};
    let id = typeof message.user === "string" ? message.user : undefined;
    if (!id && typeof message.bot_id === "string") id = `bot:${message.bot_id}`;
    if (!id) return;
    const avatarUrl = isObj(bot.icons) ? imageUrl(bot.icons) : undefined;
    return {
      id,
      name: String(bot.name || message.username || id),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  }

  async function participants(
    owner: string,
    ids: string[],
    token: string,
    previous: SlackParticipant[],
    deadline?: number,
  ): Promise<{ people: SlackParticipant[]; refreshAt: number }> {
    let complete = true;
    const people = await Promise.all(
      [...new Set(ids)].slice(0, 8).map(async (id): Promise<SlackParticipant> => {
        const saved = previous.find((person) => person.id === id) ?? { id, name: id };
        if (id.startsWith("bot:")) return saved;
        try {
          const result = await slackInfo(owner, `users.info?user=${encodeURIComponent(id)}`, token, deadline);
          if (!isObj(result.user)) throw new Error("Slack profile is unavailable.");
          const user = result.user;
          const profile = isObj(user.profile) ? user.profile : {};
          const avatarUrl = imageUrl(profile) ?? saved.avatarUrl;
          return {
            id,
            name: String(profile.display_name || profile.real_name || user.real_name || user.name || saved.name),
            ...(avatarUrl ? { avatarUrl } : {}),
          };
        } catch (error) {
          recordFailure(owner, `Slack profile ${id}`, error);
          complete = false;
          return saved;
        }
      }),
    );
    return { people, refreshAt: now() + (complete ? 86_400_000 : 60_000) };
  }

  async function refreshAvatars(owner: string, item: LoopItem): Promise<void> {
    if ((item.source ?? item.sourcePayload?.source) !== "slack") return;
    const payload = item.sourcePayload ?? {};
    if (typeof payload.slackAvatarsRefreshAt === "number" && now() < payload.slackAvatarsRefreshAt) return;
    const meta = isObj(payload.slack) ? payload.slack : {};
    if (typeof meta.channelId !== "string" || typeof meta.ts !== "string") return;
    const token = await tokenFor(deps.tokens, "slack.com", owner);
    if (!token) return;
    const deadline = now() + 3000;
    const previous = savedParticipants(payload);
    let senderId = typeof meta.userId === "string" ? meta.userId : previous[0]?.id;
    if (senderId?.startsWith("bot:")) senderId = undefined;
    if (!senderId) {
      const params = new URLSearchParams({
        channel: meta.channelId,
        oldest: meta.ts,
        latest: meta.ts,
        inclusive: "true",
        limit: "1",
      });
      const method = typeof meta.threadTs === "string" ? "conversations.replies" : "conversations.history";
      if (typeof meta.threadTs === "string") params.set("ts", meta.threadTs);
      const body = await get(owner, "slack", `${method}?${params}`, token, deadline);
      const message = Array.isArray(body.messages)
        ? body.messages.filter(isObj).find((m) => m.ts === meta.ts)
        : undefined;
      const sender = message && messageParticipant(message);
      if (!sender) return;
      senderId = sender.id;
      previous.unshift({
        ...sender,
        ...(sender.name === sender.id && typeof payload.from === "string" ? { name: payload.from } : {}),
      });
    }
    if (!previous.some((person) => person.id === senderId))
      previous.unshift({ id: senderId, name: typeof payload.from === "string" ? payload.from : senderId });
    const profiles = await participants(
      owner,
      [senderId, ...previous.map((person) => person.id)],
      token,
      previous,
      deadline,
    );
    await deps.items.annotate(
      item.id,
      {
        participants: profiles.people,
        slackAvatarsRefreshAt: profiles.refreshAt,
      },
      { expectedSourceAt: item.sourceAt, expectedSourcePayload: payload },
    );
  }

  async function refresh(owner: string, item: LoopItem): Promise<void> {
    const source = item.source ?? item.sourcePayload?.source;
    if (source !== "gmail" && source !== "slack") return;
    if (source === "gmail" && isResolved(item)) return;
    const payload = item.sourcePayload ?? {};
    const token = await tokenFor(deps.tokens, source === "gmail" ? "gmail.googleapis.com" : "slack.com", owner);
    if (!token) throw new Error(`${source === "gmail" ? "Google" : "Slack"} is not connected. Source not refreshed.`);
    if (source === "gmail") {
      const meta = isObj(payload.gmail) ? payload.gmail : {};
      if (typeof meta.threadId !== "string") return;
      const body = await get(owner, source, `threads/${encodeURIComponent(meta.threadId)}?format=metadata`, token);
      const messages = Array.isArray(body.messages) ? body.messages.filter(isObj) : [];
      const latest = messages
        .filter((m) => Array.isArray(m.labelIds) && !m.labelIds.includes("DRAFT"))
        .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
        .at(-1);
      if (latest && Array.isArray(latest.labelIds) && latest.labelIds.includes("SENT")) {
        await deps.items.recordAction(item.id, {
          kind: "replied",
          outcome: "dismissed",
          sourceAt: Number(latest.internalDate),
          ...(typeof latest.snippet === "string" ? { result: latest.snippet.slice(0, 500) } : {}),
        });
      }
      if (payload.sourceRefreshError)
        await deps.items.annotate(item.id, { sourceRefreshError: null }, { expectedSourceAt: item.sourceAt });
      return;
    }
    const meta = isObj(payload.slack) ? payload.slack : {};
    if (typeof meta.channelId !== "string" || typeof meta.ts !== "string") return;
    const channel = encodeURIComponent(meta.channelId);
    const channelInfo = await slackInfo(owner, `conversations.info?channel=${channel}`, token);
    if (!isObj(channelInfo.channel)) throw new Error("Couldn't identify the Slack conversation.");
    const direct = channelInfo.channel.is_im === true || channelInfo.channel.is_mpim === true;
    const defaultRoot = direct ? undefined : meta.ts;
    const root = typeof meta.threadTs === "string" ? meta.threadTs : defaultRoot;
    const path = root
      ? `conversations.replies?channel=${channel}&ts=${encodeURIComponent(root)}&limit=100`
      : `conversations.history?channel=${channel}&limit=100`;
    const body = await get(owner, source, path, token);
    if (!Array.isArray(body.messages)) throw new Error("Couldn't read the Slack conversation.");
    const messages = body.messages
      .filter(isObj)
      .filter((m) => !root || m.ts === root || m.thread_ts === root)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    if (root && !messages.some((m) => m.ts === root)) throw new Error("The original Slack message is unavailable.");
    const waiting = messages.find((message) => message.ts === meta.ts);
    const saved = savedParticipants(payload);
    const sender =
      (waiting && messageParticipant(waiting)) ??
      (typeof meta.userId === "string" ? { id: meta.userId, name: meta.userId } : saved[0]);
    const previous = new Map(saved.map((person) => [person.id, person]));
    for (const message of messages) {
      const person = messageParticipant(message);
      if (person)
        previous.set(person.id, {
          ...person,
          ...previous.get(person.id),
          ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
        });
    }
    if (sender && (!previous.has(sender.id) || previous.get(sender.id)?.name === sender.id))
      previous.set(sender.id, { ...sender, ...(typeof payload.from === "string" ? { name: payload.from } : {}) });
    const profiles = await participants(
      owner,
      [
        ...(sender ? [sender.id] : []),
        ...messages.toReversed().flatMap((message) => {
          const person = messageParticipant(message);
          return person ? [person.id] : [];
        }),
      ],
      token,
      [...previous.values()],
    );
    const people = new Map([...previous.values(), ...profiles.people].map((person) => [person.id, person]));
    const context = messages.map((m) => {
      const author = messageParticipant(m);
      const person = author && people.get(author.id);
      return {
        author: person?.name ?? String(m.user ?? m.username ?? "Slack"),
        ...(person ? { authorId: person.id } : {}),
        ...(person?.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
        text: typeof m.text === "string" ? m.text : "",
        at: Math.round(Number(m.ts) * 1000),
        ts: m.ts,
        ...(root && m.ts !== root ? { reply: true } : {}),
        images: (Array.isArray(m.files) ? m.files.filter(isObj) : [])
          .filter((f) => typeof f.mimetype === "string" && f.mimetype.startsWith("image/"))
          .map((f) => f.url_private)
          .filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
          .slice(0, 4),
      };
    });
    // Nearby channel context is selected by the drafting agent, not an arbitrary
    // channel tail. Keep it separate from the authoritative thread snapshot.
    const nearby =
      root && Array.isArray(payload.context)
        ? payload.context
            .filter(isObj)
            .filter((m) => m.nearby === true)
            .slice(0, 6)
        : [];
    const partial =
      body.has_more === true || (isObj(body.response_metadata) && Boolean(body.response_metadata.next_cursor));
    await deps.items.annotate(
      item.id,
      {
        slack: {
          ...meta,
          isDirectMessage: direct,
          ...(root ? { threadTs: root } : {}),
          ...(typeof waiting?.user === "string" ? { userId: waiting.user } : {}),
        },
        participants: sender ? profiles.people : saved,
        slackAvatarsRefreshAt: sender ? profiles.refreshAt : 0,
        context: [...nearby, ...context],
        sourceContextFetched: true,
        sourceContextPartial: partial,
        sourceRefreshError: null,
      },
      { expectedSourceAt: item.sourceAt },
    );
    const latest = messages.at(-1);
    // A partial thread is not evidence of its latest reply. History is newest-first
    // upstream, so its newest message remains conclusive even when older pages exist.
    if ((!root || !partial) && latest && !isResolved(item)) {
      const identity = await slackInfo(owner, "auth.test", token);
      if (typeof identity.user_id === "string" && latest.user === identity.user_id) {
        await deps.items.recordAction(item.id, {
          kind: "replied",
          outcome: "dismissed",
          sourceAt: Math.round(Number(latest.ts) * 1000),
          result: typeof latest.text === "string" ? latest.text.slice(0, 500) : "",
        });
      }
    }
  }

  async function one(owner: string, item: LoopItem, mode?: "avatars"): Promise<void> {
    const itemKey = `${owner}:${item.id}:${item.sourceAt ?? 0}`;
    const key = `${itemKey}:${mode ?? "source"}`;
    if (checked.has(key)) return;
    const pending = running.get(itemKey);
    if (pending) {
      if (mode === "avatars") return;
      await pending;
      const latest = await deps.items.get(item.id);
      if (latest && latest.sourceAt === item.sourceAt) return one(owner, latest, mode);
      return;
    }
    const task = (async () => {
      try {
        if (mode === "avatars") await refreshAvatars(owner, item);
        else await refresh(owner, item);
      } catch (e) {
        recordFailure(owner, `Inbox item ${item.id}`, e);
        if (mode === "avatars") return;
        await deps.items.annotate(
          item.id,
          {
            sourceRefreshError: e instanceof Error ? e.message : "Source refresh failed.",
          },
          { expectedSourceAt: item.sourceAt },
        );
      } finally {
        checked.set(key, true);
        running.delete(itemKey);
      }
    })();
    running.set(itemKey, task);
    return task;
  }
  return async (owner, items, mode) => {
    if (!(await deps.featureFlags.enabled("inbox_loops", personalScope(owner)))) return;
    const positionKey = `${owner}:${mode ?? "source"}`;
    const start = positions.get(positionKey) ?? 0;
    const ordered = items.slice(start).concat(items.slice(0, start));
    const deadline = now() + 3000;
    let visited = 0;
    for (; visited < ordered.length && now() < deadline; visited += 4)
      await Promise.all(ordered.slice(visited, visited + 4).map((item) => one(owner, item, mode)));
    // Slow sources must neither block the whole inbox nor starve later cards.
    if (items.length > 1) positions.set(positionKey, (start + visited) % items.length);
  };
}
