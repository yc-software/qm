import { canonicalPerson } from "../../directory/person.ts";
import { scopeId, type Cron } from "../../types.ts";
import { ensureInboxCron, inboxName, INBOX_SOURCES } from "../../inbox/sync-task.ts";
import { isResolved, ledgerItemView } from "../../inbox/view.ts";
import { uiStateId } from "../../surfaces/ui-state.ts";
import { sendJson } from "../http.ts";
import { canAdministerCron } from "../control-service.ts";
import { actingPrincipal, appCrons, cronSummary, inboxDeps } from "./cron-items.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

type FeedKey = [number, number, string];

function compareKeys(a: FeedKey, b: ReadonlyArray<number | string>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

function inboxTitle(cron: Cron): string {
  return cron.inbox?.source ? inboxName(cron.inbox.source) : (cron.title ?? cron.id);
}

async function inbox(ctx: ApiCtx): Promise<void> {
  const deps = inboxDeps(ctx);
  const preferences = ctx.deps.uiState;
  if (!deps || !preferences) return sendJson(ctx.res, 503, { error: "inbox_unavailable" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  if (!(await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", acting.actorId))))
    return sendJson(ctx.res, 403, { error: "feature_disabled" });
  if (ctx.capability && ctx.capability.privateScope !== true) return sendJson(ctx.res, 403, { error: "forbidden" });
  const defaults = [];
  for (const { source } of INBOX_SOURCES) defaults.push(await ensureInboxCron(appCrons(ctx), acting.actorId, source));
  const id = uiStateId(acting.actorId, "inbox-crons");
  const pref = await preferences.putIfAbsent(id, { value: defaults.map((cron) => cron.id), updatedAt: Date.now() });
  const available: Cron[] = [];
  for (const cron of await ctx.app.listCrons()) {
    if (cron.inbox && !cron.archived && (await canAdministerCron(ctx.app, cron, acting.actorId))) available.push(cron);
  }
  let ids = Array.isArray(pref.value) ? pref.value.filter((value): value is string => typeof value === "string") : [];
  if (ctx.method === "PUT") {
    const body = isObj(ctx.body) ? ctx.body : {};
    if (
      !Array.isArray(body.cronIds) ||
      body.cronIds.length > 100 ||
      body.cronIds.some((value) => typeof value !== "string")
    ) {
      return sendJson(ctx.res, 400, { error: "invalid_selection" });
    }
    ids = [...new Set(body.cronIds as string[])];
    if (ids.some((value) => !available.some((cron) => cron.id === value)))
      return sendJson(ctx.res, 403, { error: "forbidden" });
    await preferences.put(id, { value: ids, updatedAt: Date.now() });
  }
  const selected = ids.flatMap((value) => available.filter((cron) => cron.id === value));
  const selectedIds = selected.map((cron) => cron.id);
  const cronsById = new Map(selected.map((cron) => [cron.id, cron]));
  if (ctx.method === "GET" && ctx.deps.inboxSourceRefresh) {
    const mailCrons = selected.filter((cron) => cron.owner === acting.actorId && cron.inbox?.source === "gmail");
    const mail = (await Promise.all(mailCrons.map((cron) => deps.items.byCron(cron.id))))
      .flat()
      .filter((item) => !isResolved(item) && (item.source ?? item.sourcePayload?.source) === "gmail");
    await ctx.deps.inboxSourceRefresh(acting.actorId, mail);
  }
  const summaries = (await deps.items.summaries(selectedIds, { includeInboxMetadata: true })).filter(
    (item) => selectedIds.includes(item.cronId) && item.inboxPreview?.sentChat !== true,
  );
  const itemId = ctx.url.searchParams.get("itemId");
  if (itemId) {
    const item = await deps.items.get(itemId);
    if (!item || !selectedIds.includes(item.cronId)) return sendJson(ctx.res, 404, { error: "not_found" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(item) });
  }
  const requestedFilter = ctx.url.searchParams.get("filter");
  if (requestedFilter !== null && !["all", "human", "triaged"].includes(requestedFilter))
    return sendJson(ctx.res, 400, { error: "invalid_filter" });
  const savedFilter = requestedFilter ?? (await preferences.get(uiStateId(acting.actorId, "inbox-filter")))?.value;
  const inboxFilter = savedFilter === "all" || savedFilter === "triaged" ? savedFilter : "human";
  const handled = ctx.url.searchParams.get("view") === "handled";
  const sent = ctx.url.searchParams.get("view") === "sent";
  const filter = ctx.url.searchParams.get("cronId");
  const open = summaries.filter((item) => item.status !== "shipped" && item.status !== "skipped");
  const attention = open.filter((item) => {
    if (item.source === "gmail") {
      if (inboxFilter === "all") return true;
      if (item.inboxPreview?.automated === true) return false;
      if (inboxFilter === "human") return true;
      if (item.inboxPreview?.probablyResolved === true) return false;
    }
    return item.status === "ready" || (item.status === "failed" && Boolean(item.parkedReason));
  });
  const counts = new Map<string, number>();
  for (const item of open) counts.set(item.cronId, (counts.get(item.cronId) ?? 0) + 1);
  let candidates = attention;
  if (sent)
    candidates = summaries.filter(
      (item) =>
        item.actionKind === "send" && item.status === "shipped" && (item.source === "gmail" || item.source === "slack"),
    );
  else if (handled) candidates = summaries.filter((item) => item.status === "shipped" || item.status === "skipped");
  const keys = new Map<string, FeedKey>(
    candidates.map((item) => [item.id, [isResolved(item) ? 1 : 0, -item.createdAt, item.id]]),
  );
  let feed = candidates
    .filter((item) => !filter || item.cronId === filter)
    .sort((a, b) => compareKeys(keys.get(a.id)!, keys.get(b.id)!));
  const cursor = ctx.url.searchParams.get("cursor");
  if (cursor) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      return sendJson(ctx.res, 400, { error: "invalid_cursor" });
    }
    if (!Array.isArray(value) || value.some((part) => typeof part !== "number" && typeof part !== "string"))
      return sendJson(ctx.res, 400, { error: "invalid_cursor" });
    const after = value as Array<number | string>;
    feed = feed.filter((item) => compareKeys(keys.get(item.id)!, after) > 0);
  }
  const page = feed.slice(0, 40);
  const last = page.at(-1);
  if (ctx.method === "GET" && ctx.deps.inboxSourceRefresh) {
    const slack = (
      await Promise.all(
        page
          .filter(
            (item) =>
              item.source === "slack" &&
              cronsById.get(item.cronId)?.owner === acting.actorId &&
              !(
                typeof item.inboxPreview?.slackAvatarsRefreshAt === "number" &&
                Date.now() < item.inboxPreview.slackAvatarsRefreshAt
              ),
          )
          .map((item) => deps.items.get(item.id)),
      )
    ).filter((item) => item !== null);
    await ctx.deps.inboxSourceRefresh(acting.actorId, slack, "avatars");
    for (const refreshed of await Promise.all(slack.map((item) => deps.items.get(item.id)))) {
      const summary = page.find((entry) => entry.id === refreshed?.id);
      if (summary && refreshed && refreshed.sourceAt === summary.sourceAt)
        summary.inboxPreview = { ...summary.inboxPreview, participants: refreshed.sourcePayload?.participants };
    }
  }
  sendJson(ctx.res, 200, {
    selected: selected.map((cron) => ({
      id: cron.id,
      name: inboxTitle(cron),
      sources: [
        ...new Set([
          ...(cron.inbox?.source ? [cron.inbox.source] : []),
          ...summaries.filter((item) => item.cronId === cron.id).flatMap((item) => (item.source ? [item.source] : [])),
        ]),
      ],
      count: counts.get(cron.id) ?? 0,
      syncCron: cronSummary(cron),
      source: cron.inbox?.source,
    })),
    available: available.map((cron) => ({
      id: cron.id,
      name: inboxTitle(cron),
      sources: cron.inbox?.source ? [cron.inbox.source] : [],
      source: cron.inbox?.source,
      selected: selectedIds.includes(cron.id),
    })),
    filter: inboxFilter,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    items: page.map((item) =>
      ledgerItemView({
        ...item,
        sourcePayload: item.inboxPreview ?? {
          title: item.sourceSummary ?? "Review item",
          snippet: item.parkedReason ?? item.sourceSummary ?? "",
        },
      }),
    ),
    nextCursor:
      feed.length > page.length && last ? Buffer.from(JSON.stringify(keys.get(last.id))).toString("base64url") : null,
  });
}

async function access(ctx: ApiCtx): Promise<void> {
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  sendJson(ctx.res, 200, {
    enabled: (await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", acting.actorId))) === true,
  });
}

async function viewers(ctx: ApiCtx): Promise<void> {
  if (ctx.capability || ctx.actor) return sendJson(ctx.res, 403, { error: "forbidden" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const cron = typeof body.cronId === "string" ? await ctx.app.getCron(body.cronId) : null;
  if (!cron?.inbox) return sendJson(ctx.res, 404, { error: "not_found" });
  const candidates = Array.isArray(body.candidates)
    ? [...new Set(body.candidates.filter((value): value is string => typeof value === "string"))]
    : [];
  const identity = ctx.deps.identity;
  await identity?.refresh();
  const allowed = await Promise.all(
    candidates.map(
      async (id) =>
        (!identity || identity.classify(id).type === "internal") &&
        canAdministerCron(ctx.app, cron, canonicalPerson(id)),
    ),
  );
  sendJson(ctx.res, 200, { viewers: candidates.filter((_, i) => allowed[i]) });
}

export const inboxRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/inbox", actor: "query.principalId", auth: "source", handle: inbox },
  { method: "POST", path: "/v1/inbox/viewers", actor: "system", auth: "source", handle: viewers },
  { method: "GET", path: "/v1/inbox/access", actor: "query.principalId", auth: "source", handle: access },
  { method: "PUT", path: "/v1/inbox", actor: "query.principalId", auth: "source", handle: inbox },
];
