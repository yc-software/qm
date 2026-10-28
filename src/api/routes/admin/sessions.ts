import type { App } from "../../app.ts";
import type { ServerDeps } from "../../deps.ts";
import { type Session } from "../../../types.ts";
import { sessionCategory, type SessionCategory, type SessionSummary } from "../../../sessions/session-store.ts";
import { createTranscriptSource } from "../../../sessions/transcript-source.ts";
import { isUserMessage, type Item } from "../../../sessions/items.ts";
import { type ApiCtx, ok, type RouteResult } from "../route.ts";
import { badRequest, limitParam, requireScopedResource, scopedAdmin } from "./common.ts";
import { activityCounts, scopeActivity } from "./scope-activity.ts";
import { parseSessionWakeRef, sessionKind, sessionOrigin, type AdminSessionOrigin } from "./origins.ts";

const SESSIONS_PAGE_LIMIT_MAX = 200;
const SESSIONS_PAGE_LIMIT_DEFAULT = 50;
const TRANSCRIPT_LIMIT_MAX = 50000;
const TRANSCRIPT_LIMIT_DEFAULT = 500;

async function labelTranscriptItems(app: App, deps: ServerDeps, session: Session, items: Item[]): Promise<Item[]> {
  const participantIds = new Set((await deps.sessions?.participantsOf(session.id)) ?? []);
  if (participantIds.size !== 1) return items;
  const only = [...participantIds][0]!;
  const name = (await app.directoryMember(only))?.displayName?.trim() || only;
  if (!name.trim()) return items;
  return items.map((item) =>
    !isUserMessage(item) || (typeof item.body.name === "string" && item.body.name.trim())
      ? item
      : { ...item, body: { ...item.body, name } },
  );
}

const requireAdminSession = (ctx: ApiCtx, id: string) =>
  requireScopedResource(ctx, () => ctx.deps.sessions?.get(id), "scopeId", "session", "fallback");

async function cronFireResults(app: App, summaries: readonly SessionSummary[]): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const rowThreadRefs = new Set<string>();
  for (const s of summaries) {
    if (parseSessionWakeRef(s.threadRef)?.trigger === "cron") rowThreadRefs.add(s.threadRef);
  }
  if (!rowThreadRefs.size) return results;
  for (const fire of await app.cronFiresByThreadRefs([...rowThreadRefs])) {
    const digest = fire.reply?.trim() || fire.note?.trim();
    if (digest) results.set(fire.threadRef, digest);
  }
  return results;
}

export async function listAdminSessions(ctx: ApiCtx): Promise<RouteResult> {
  const { res, app, deps, url } = ctx;
  const authz = await scopedAdmin(ctx, "sessions");
  const { scope, orgWide } = authz;
  const categoryParam = url.searchParams.get("category") ?? "conversation";
  let category: SessionCategory | "all" = "conversation";
  if (categoryParam === "background" || categoryParam === "all") category = categoryParam;
  const categoryFilter = category === "all" ? undefined : category;
  const originParam = url.searchParams.get("origin");
  const originFilter: AdminSessionOrigin | undefined =
    originParam === "cron" || originParam === "other_background" ? originParam : undefined;
  const cronId = url.searchParams.get("cron") || undefined;
  const limit = limitParam(url, SESSIONS_PAGE_LIMIT_DEFAULT, SESSIONS_PAGE_LIMIT_MAX);
  const cursorParam = url.searchParams.get("cursor");
  const cursorMatch = cursorParam ? /^(\d+)~(.+)$/.exec(cursorParam) : null;
  const before = cursorMatch ? { lastActivity: Number(cursorMatch[1]), id: cursorMatch[2]! } : undefined;
  const disconnected = new AbortController();
  res.once("close", () => disconnected.abort());
  const fetched =
    (await deps.sessions
      ?.scopeSessionSummaries(scope, orgWide, {
        limit: limit + 1,
        signal: disconnected.signal,
        ...(before ? { before } : {}),
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...(originFilter ? { origin: originFilter } : {}),
        ...(cronId ? { cronId } : {}),
      })
      .catch((error: unknown) => {
        if (disconnected.signal.aborted) return null;
        throw error;
      })) ?? [];
  if (disconnected.signal.aborted) return;
  const summaries = fetched.slice(0, limit);
  const last = fetched.length > limit ? summaries[summaries.length - 1] : undefined;
  const fireResults = await cronFireResults(app, summaries);
  const pageCronIds = new Set<string>(cronId ? [cronId] : []);
  for (const s of summaries) {
    const wake = parseSessionWakeRef(s.threadRef);
    if (wake?.trigger === "cron") pageCronIds.add(wake.sourceId);
  }
  const pageCrons = await Promise.all([...pageCronIds].map(async (id) => [id, await app.getCron(id)] as const));
  const cronLookup = new Map(pageCrons.flatMap(([id, cron]) => (cron ? [[id, cron] as const] : [])));
  const sessions = await Promise.all(
    summaries.map(async (s) => {
      const cronRow = parseSessionWakeRef(s.threadRef)?.trigger === "cron";
      const result = cronRow ? fireResults.get(s.threadRef) || s.lastMessage || s.firstMessage : undefined;
      return {
        ...s,
        category: sessionCategory(s.origin),
        kind: sessionKind(s),
        origin: await sessionOrigin(app, s, scope, cronLookup),
        ...(result ? { result } : {}),
      };
    }),
  );
  const activity = scopeActivity(deps.sessions);
  return ok({
    scopeId: scope,
    sessions,
    ...(cronId
      ? {
          cron: await sessionOrigin(
            app,
            { threadRef: `agent:main:cron:${cronId}`, scopeId: summaries[0]?.scopeId ?? scope },
            scope,
            cronLookup,
          ),
        }
      : {}),
    category,
    limit,
    ...(last ? { nextCursor: `${last.lastActivity}~${last.id}` } : {}),
    ...(activity ? { counts: activityCounts(activity, scope, orgWide), countsAsOf: activity.asOf } : {}),
  });
}

export async function getAdminSessionLlm(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, params, url } = ctx;
  const id = params.id!;
  const scoped = await requireAdminSession(ctx, id);
  const { record: session } = scoped;
  scoped.audit("session.llm.read", id, session.scopeId);
  const turnParam = url.searchParams.get("turnSeq");
  let opts: { orphans: true } | { turnSeqs: number[] } | undefined;
  if (turnParam === "orphan") opts = { orphans: true };
  else if (turnParam != null && turnParam !== "") {
    if (!Number.isInteger(Number(turnParam))) throw badRequest('turnSeq must be an integer or "orphan"');
    opts = { turnSeqs: [Number(turnParam)] };
  }
  const requests = (await deps.sessions?.listLlmRequests(id, opts)) ?? [];
  return ok({ session, requests });
}

export async function getAdminSession(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, params, url } = ctx;
  const id = params.id!;
  const scoped = await requireAdminSession(ctx, id);
  const { scope, record: session } = scoped;
  scoped.audit("session.read", id, session.scopeId);
  const want = Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || TRANSCRIPT_LIMIT_DEFAULT);
  const all = want >= TRANSCRIPT_LIMIT_MAX;
  const limit = Math.min(want, TRANSCRIPT_LIMIT_MAX);
  const raw = deps.sessions
    ? (await createTranscriptSource(deps.sessions).forRender(id, all ? undefined : { limit: limit + 1 })).items
    : [];
  const hasMore = !all && raw.length > limit;
  const items = await labelTranscriptItems(app, deps, session, hasMore ? raw.slice(raw.length - limit) : raw);
  return ok({
    session,
    items,
    hasMore,
    limit,
    origin: await sessionOrigin(app, session, scope),
  });
}
