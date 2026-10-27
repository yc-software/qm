import { LRUCache } from "lru-cache";
import { personalScope, type InboxItem } from "../types.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import { redactSecrets } from "../../plugins/chassis/src/redact-secrets.ts";
import { errMessage } from "../util/errors.ts";
import type { InboxEventSink, InboxLedger } from "./ledger.ts";
import type { ConnectorTokenSource } from "./sources/adapter.ts";
import type { RefreshKit, SourceRefresher } from "./sources/refresh.ts";
import { createGmailRefresher } from "./sources/gmail-refresh.ts";
import { createSlackRefresher } from "./sources/slack-refresh.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { perTenant } from "../tenant.ts";

interface RefreshDeps {
  items: InboxLedger;
  tokens: ConnectorTokenSource;
  directory: Pick<DirectoryStore, "getBySlackId">;
  featureFlags: Pick<FeatureFlagStore, "enabled">;
  errors?: ErrorLog;
  record: InboxEventSink;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
  now?: () => number;
}

export type InboxSourceRefresh = (owner: string, items: InboxItem[], mode?: "avatars") => Promise<void>;

export function createInboxSourceRefresh(deps: RefreshDeps): InboxSourceRefresh {
  const caches = perTenant(() => ({
    checked: new LRUCache<string, boolean>({ max: 2000, ttl: 60_000 }),
    info: new LRUCache<string, Record<string, unknown>>({ max: 2000, ttl: 300_000 }),
    limited: new LRUCache<string, boolean>({ max: 2000 }),
    running: new Map<string, Promise<void>>(),
    infoRunning: new Map<string, Promise<Record<string, unknown>>>(),
    positions: new LRUCache<string, number>({ max: 2000 }),
  }));
  const now = deps.now ?? Date.now;

  function recordFailure(owner: string, subject: string, error: unknown): void {
    deps.errors?.record({
      category: "inbox",
      code: "source_refresh_failed",
      message: redactSecrets(`${subject}: ${errMessage(error)}`),
      scopeLabel: personalScope(owner),
    });
  }

  const kit: RefreshKit = {
    items: deps.items,
    now,
    recordFailure,
    limiter(owner, key) {
      const { limited } = caches();
      const limitKey = `${owner}:${key}`;
      if (limited.has(limitKey)) throw new Error("Source rate limited. The next refresh will retry.");
      return (retry) => limited.set(limitKey, true, { ttl: Math.max(60, Number.isFinite(retry) ? retry : 60) * 1000 });
    },
    failure(cause) {
      return new Error("Couldn't refresh the source. Your item has not been dismissed.", { cause });
    },
    cached(key, load) {
      const { info, infoRunning } = caches();
      const hit = info.get(key);
      if (hit) return Promise.resolve(hit);
      const pending = infoRunning.get(key);
      if (pending) return pending;
      const task = load()
        .then((value) => {
          info.set(key, value);
          return value;
        })
        .finally(() => infoRunning.delete(key));
      infoRunning.set(key, task);
      return task;
    },
    async ownerReplied(item, at, text) {
      if (!Number.isFinite(at) || at <= (item.sourceAt ?? 0)) return;
      await deps.record(item, { author: "owner", at, text });
    },
  };

  const refreshers = new Map<string, SourceRefresher>([
    ["gmail", createGmailRefresher(kit, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })],
    [
      "slack",
      createSlackRefresher(kit, {
        directory: deps.directory,
        ...(deps.slackApiUrl ? { slackApiUrl: deps.slackApiUrl } : {}),
      }),
    ],
  ]);

  async function refresh(owner: string, item: InboxItem): Promise<void> {
    const refresher = item.source ? refreshers.get(item.source) : undefined;
    if (!refresher) return;
    await refresher.refresh(owner, item, async () => {
      const token = await refresher.connectorToken(deps.tokens, owner, item);
      if (!token) throw new Error(`${refresher.connectorName} is not connected. Source not refreshed.`);
      return token;
    });
  }

  async function refreshAvatars(owner: string, item: InboxItem): Promise<void> {
    await (item.source ? refreshers.get(item.source) : undefined)?.refreshAvatars?.(owner, item);
  }

  async function one(owner: string, item: InboxItem, mode?: "avatars"): Promise<void> {
    const { checked, running } = caches();
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
    const { positions } = caches();
    const positionKey = `${owner}:${mode ?? "source"}`;
    const start = positions.get(positionKey) ?? 0;
    const ordered = items.slice(start).concat(items.slice(0, start));
    const deadline = now() + 3000;
    let visited = 0;
    for (; visited < ordered.length && now() < deadline; visited += 4)
      await Promise.all(ordered.slice(visited, visited + 4).map((item) => one(owner, item, mode)));
    if (items.length > 1) positions.set(positionKey, (start + visited) % items.length);
  };
}
