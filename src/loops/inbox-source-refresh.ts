import { LRUCache } from "lru-cache";
import type { LoopItem } from "../types.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { isResolved } from "./ledger-view.ts";
import { isObj, tokenFor, type ConnectorTokenSource } from "./sources/adapter.ts";
import { normalizeSlackApiUrl } from "../slack/config.ts";

interface RefreshDeps {
  items: LoopItemLedger;
  tokens: ConnectorTokenSource;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
  now?: () => number;
}

export type InboxSourceRefresh = (owner: string, items: LoopItem[]) => Promise<void>;

// Reuse the inbox's existing refresh cycle, not a second provider poller. Cache only
// results/identities, never credentials, and share in-flight reads between tabs.
export function createInboxSourceRefresh(deps: RefreshDeps): InboxSourceRefresh {
  const checked = new LRUCache<string, boolean>({ max: 2000, ttl: 60_000 });
  const info = new LRUCache<string, Record<string, unknown>>({ max: 2000, ttl: 300_000 });
  const limited = new LRUCache<string, boolean>({ max: 2000 });
  const running = new Map<string, Promise<void>>();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const positions = new LRUCache<string, number>({ max: 2000 });
  const slackBase = normalizeSlackApiUrl(deps.slackApiUrl ?? "https://slack.com/api");

  async function get(owner: string, source: string, path: string, token: string): Promise<Record<string, unknown>> {
    const method = path.split("?")[0]!;
    const key = `${owner}:${source}:${source === "slack" ? method : "read"}`;
    if (limited.has(key)) throw new Error("Source rate limited. The next refresh will retry.");
    const base = source === "slack" ? slackBase : "https://gmail.googleapis.com/gmail/v1/users/me/";
    const res = await fetchImpl(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      limited.set(key, true, { ttl: Math.max(60, Number.isFinite(retry) ? retry : 60) * 1000 });
    }
    if (!res.ok) throw new Error("Couldn't refresh the source. Your item has not been dismissed.");
    const body: unknown = await res.json();
    if (!isObj(body) || body.ok === false)
      throw new Error("Couldn't refresh the source. Your item has not been dismissed.");
    return body;
  }

  async function slackInfo(owner: string, path: string, token: string): Promise<Record<string, unknown>> {
    const key = `${owner}:${path}`;
    const cached = info.get(key);
    if (cached) return cached;
    const value = await get(owner, "slack", path, token);
    info.set(key, value);
    return value;
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
    const names = new Map<string, string>();
    for (const user of [
      ...new Set(messages.map((m) => m.user).filter((u): u is string => typeof u === "string")),
    ].slice(0, 8)) {
      try {
        const result = await slackInfo(owner, `users.info?user=${encodeURIComponent(user)}`, token);
        const u = isObj(result.user) ? result.user : {};
        const profile = isObj(u.profile) ? u.profile : {};
        names.set(user, String(profile.display_name || profile.real_name || u.real_name || u.name || user));
      } catch {
        /* User names are cosmetic; message history remains usable. */
      }
    }
    const context = messages.map((m) => ({
      author: names.get(String(m.user)) ?? String(m.user ?? m.username ?? "Slack"),
      text: typeof m.text === "string" ? m.text : "",
      at: Math.round(Number(m.ts) * 1000),
      ts: m.ts,
      ...(root && m.ts !== root ? { reply: true } : {}),
      images: (Array.isArray(m.files) ? m.files.filter(isObj) : [])
        .filter((f) => typeof f.mimetype === "string" && f.mimetype.startsWith("image/"))
        .map((f) => f.url_private)
        .filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
        .slice(0, 4),
    }));
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
        slack: { ...meta, isDirectMessage: direct, ...(root ? { threadTs: root } : {}) },
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

  async function one(owner: string, item: LoopItem): Promise<void> {
    const key = `${owner}:${item.id}:${item.sourceAt ?? 0}`;
    const pending = running.get(key);
    if (pending) return pending;
    if (checked.has(key)) return;
    const task = (async () => {
      try {
        await refresh(owner, item);
      } catch (e) {
        await deps.items.annotate(
          item.id,
          {
            sourceRefreshError: e instanceof Error ? e.message : "Source refresh failed.",
          },
          { expectedSourceAt: item.sourceAt },
        );
      } finally {
        checked.set(key, true);
        running.delete(key);
      }
    })();
    running.set(key, task);
    return task;
  }
  return async (owner, items) => {
    // Bound simultaneous Gmail reads. Slack is refreshed only for an opened item;
    // normal Slack reconciliation still comes from events and the existing sync.
    const start = positions.get(owner) ?? 0;
    const ordered = items.slice(start).concat(items.slice(0, start));
    const deadline = now() + 3000;
    let visited = 0;
    for (; visited < ordered.length && now() < deadline; visited += 4)
      await Promise.all(ordered.slice(visited, visited + 4).map((item) => one(owner, item)));
    // Slow sources must neither block the whole inbox nor starve later cards.
    if (items.length > 1) positions.set(owner, (start + visited) % items.length);
  };
}
