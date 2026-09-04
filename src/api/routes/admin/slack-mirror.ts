import type { App } from "../../app.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

const SLACK_MIRROR_PAGE_MAX = 400;
const SLACK_MIRROR_PAGE_DEFAULT = 200;

async function mirrorNames(deps: ApiCtx["deps"]) {
  const members = deps.directory ? await deps.directory.list() : [];
  const byId = new Map<string, string>();
  for (const m of members) {
    if (!m.displayName) continue;
    byId.set(m.principalId, m.displayName);
    if (m.slackId) byId.set(m.slackId, m.displayName);
  }
  return {
    author: (id?: string): string | undefined => (id ? byId.get(id) : undefined),
    mentions(text?: string, existing?: Record<string, string>): Record<string, string> | undefined {
      const out: Record<string, string> = { ...existing };
      for (const m of (text ?? "").matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
        const id = m[1];
        if (!id || out[id]) continue;
        const name = byId.get(id);
        if (name) out[id] = name;
      }
      return Object.keys(out).length ? out : existing;
    },
  };
}

export async function listSlackMirrorContainers(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(deps, { principalId: actor.id, action: "slack_mirror.read", resource: "slack-mirror", scopeLabel: scope });
  const raw = await app.listSurfaceContainers();
  const channelsById = new Map((await app.directoryChannels()).map((c) => [c.channelId.toLowerCase(), c.name]));
  const containers = raw.map((c) => ({ ...c, name: c.name ?? channelsById.get(c.container.toLowerCase()) }));
  return sendJson(res, 200, { scopeId: scope, containers });
}

export async function listSlackMirrorMessages(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const container = (url.searchParams.get("container") ?? "").trim();
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!container && !q) return sendJson(res, 400, { error: "bad_request", message: "container or q required" });
  const limit = Math.min(
    SLACK_MIRROR_PAGE_MAX,
    Math.max(1, Number(url.searchParams.get("limit")) || SLACK_MIRROR_PAGE_DEFAULT),
  );
  audit(deps, {
    principalId: actor.id,
    action: "slack_mirror.messages.read",
    resource: container || `search:${q}`,
    scopeLabel: scope,
  });
  const names = await mirrorNames(deps);
  const withNames = (rows: Awaited<ReturnType<App["readSurfaceMessages"]>>) =>
    rows.map((m) => ({
      ...m,
      authorName: m.authorName ?? names.author(m.authorId),
      mentions: names.mentions(m.text, m.mentions),
    }));
  if (q) {
    const messages = withNames(await app.searchSurface(q, { ...(container ? { container } : {}), limit }));
    return sendJson(res, 200, { scopeId: scope, mode: "search", query: q, messages });
  }
  const before = url.searchParams.get("before") ?? undefined;
  const raw = await app.readSurfaceMessages(container, {
    limit: limit + 1,
    includeDeleted: true,
    noFallback: true,
    ...(before ? { before } : {}),
  });
  const hasMore = raw.length > limit;
  const messages = withNames(hasMore ? raw.slice(raw.length - limit) : raw);
  return sendJson(res, 200, { scopeId: scope, mode: "timeline", container, messages, hasMore, limit });
}

export async function listAmbientJudgments(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = deps.ambientJudgments;
  if (!store) return sendJson(res, 200, { scopeId: scope, judgments: [], counts: { act: 0, ignore: 0, fastlane: 0 } });
  const container = (url.searchParams.get("container") ?? "").trim() || undefined;
  const id = Number(url.searchParams.get("id"));
  audit(deps, {
    principalId: actor.id,
    action: "ambient_judgments.read",
    resource: container ?? "all",
    scopeLabel: scope,
  });
  if (id) {
    const judgment = await store.get(id);
    if (!judgment) return sendJson(res, 404, { error: "not_found" });
    const workspaceUrl = deps.directory ? (await deps.directory.meta()).workspaceUrl : null;
    return sendJson(res, 200, { scopeId: scope, judgment, workspaceUrl });
  }
  const decision = (url.searchParams.get("decision") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d): d is "act" | "ignore" | "fastlane" => d === "act" || d === "ignore" || d === "fastlane");
  const before = Number(url.searchParams.get("before")) || undefined;
  const beforeId = Number(url.searchParams.get("beforeId")) || undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const [judgments, counts] = await Promise.all([
    store.list({
      ...(container ? { container } : {}),
      ...(decision.length ? { decision } : {}),
      ...(before ? { before } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: limit + 1,
    }),
    store.counts(container ? { container } : {}),
  ]);
  const hasMore = judgments.length > limit;
  return sendJson(res, 200, {
    scopeId: scope,
    judgments: hasMore ? judgments.slice(0, limit) : judgments,
    counts,
    hasMore,
    limit,
  });
}

export async function listAckEmojiPicks(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = deps.ackEmojiPicks;
  if (!store) return sendJson(res, 200, { scopeId: scope, picks: [], counts: { picked: 0, declined: 0 } });
  const channel = (url.searchParams.get("container") ?? "").trim() || undefined;
  const id = Number(url.searchParams.get("id"));
  audit(deps, { principalId: actor.id, action: "ack_emoji_picks.read", resource: channel ?? "all", scopeLabel: scope });
  if (id) {
    const pick = await store.get(id);
    if (!pick) return sendJson(res, 404, { error: "not_found" });
    const workspaceUrl = deps.directory ? (await deps.directory.meta()).workspaceUrl : null;
    return sendJson(res, 200, { scopeId: scope, pick, workspaceUrl });
  }
  const outcome = (url.searchParams.get("outcome") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d): d is "picked" | "declined" => d === "picked" || d === "declined");
  const before = Number(url.searchParams.get("before")) || undefined;
  const beforeId = Number(url.searchParams.get("beforeId")) || undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const [picks, counts] = await Promise.all([
    store.list({
      ...(channel ? { channel } : {}),
      ...(outcome.length ? { outcome } : {}),
      ...(before ? { before } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: limit + 1,
    }),
    store.counts(channel ? { channel } : {}),
  ]);
  const hasMore = picks.length > limit;
  return sendJson(res, 200, { scopeId: scope, picks: hasMore ? picks.slice(0, limit) : picks, counts, hasMore, limit });
}
