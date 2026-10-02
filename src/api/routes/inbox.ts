import { migrateInbox } from "../../loops/inbox-migration.ts";
import { scopeId, type Loop } from "../../types.ts";
import { ensureDefaultInboxLoops, findInboxLoop } from "../../loops/inbox-loop.ts";
import {
  compareKeys,
  consolidates,
  isResolved,
  ledgerItemView,
  prioritizes,
  triageKeys,
} from "../../loops/ledger-view.ts";
import { uiStateId } from "../../surfaces/ui-state.ts";
import { sendJson } from "../http.ts";
import { actingPrincipal, canAdministerLoop, loopDeps } from "./loops.ts";
import { cronSummary } from "./loop-items.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function inbox(ctx: ApiCtx): Promise<void> {
  const deps = loopDeps(ctx);
  const preferences = ctx.deps.uiState;
  if (!deps || !preferences) return sendJson(ctx.res, 503, { error: "inbox_unavailable" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  if (!(await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", acting.actorId))))
    return sendJson(ctx.res, 403, { error: "feature_disabled" });
  if (ctx.capability && ctx.capability.privateScope !== true) return sendJson(ctx.res, 403, { error: "forbidden" });
  const defaults = await ensureDefaultInboxLoops(deps.store, acting.actorId);
  const legacy = await findInboxLoop(deps.store, acting.actorId);
  const migrated = legacy ? await migrateInbox(deps, preferences, legacy, defaults) : true;
  const legacyItems = legacy ? await deps.items.summaries([legacy.id]) : [];
  const id = uiStateId(acting.actorId, "inbox-loops");
  const pref = await preferences.putIfAbsent(id, {
    value: [...defaults.map((loop) => loop.id), ...(legacy && (!migrated || legacyItems.length) ? [legacy.id] : [])],
    updatedAt: Date.now(),
  });
  const available: Loop[] = [];
  for (const loop of await deps.store.list()) {
    if (loop.id === legacy?.id && migrated && legacyItems.length === 0) continue;
    if (await canAdministerLoop(ctx, loop, acting)) available.push(loop);
  }
  let ids = Array.isArray(pref.value) ? pref.value.filter((value): value is string => typeof value === "string") : [];
  if (ctx.method === "PUT") {
    const body = isObj(ctx.body) ? ctx.body : {};
    if (
      !Array.isArray(body.loopIds) ||
      body.loopIds.length > 100 ||
      body.loopIds.some((value) => typeof value !== "string")
    ) {
      return sendJson(ctx.res, 400, { error: "invalid_selection" });
    }
    ids = [...new Set(body.loopIds as string[])];
    if (ids.some((value) => !available.some((loop) => loop.id === value)))
      return sendJson(ctx.res, 403, { error: "forbidden" });
    await preferences.put(id, { value: ids, updatedAt: Date.now() });
  }
  const selected = ids.flatMap((value) => available.filter((loop) => loop.id === value));
  const selectedIds = selected.map((loop) => loop.id);
  if (ctx.method === "GET" && ctx.deps.inboxSourceRefresh) {
    const mailLoops = selected.filter(
      (loop) =>
        loop.owner === acting.actorId &&
        (loop.surface === "inbox" || loop.surface?.startsWith("inbox:")) &&
        (!loop.sources?.length || loop.sources.includes("gmail")),
    );
    const mail = (await Promise.all(mailLoops.map((loop) => deps.items.byLoop(loop.id))))
      .flat()
      .filter((item) => !isResolved(item) && (item.source ?? item.sourcePayload?.source) === "gmail");
    await ctx.deps.inboxSourceRefresh(acting.actorId, mail);
  }
  const summaries = (await deps.items.summaries(selectedIds, { includeEmailClassification: true })).filter(
    (item) => selectedIds.includes(item.loopId) && item.inboxPreview?.sentChat !== true,
  );
  const itemId = ctx.url.searchParams.get("itemId");
  if (itemId) {
    const item = await deps.items.get(itemId);
    if (!item || !selectedIds.includes(item.loopId)) return sendJson(ctx.res, 404, { error: "not_found" });
    return sendJson(ctx.res, 200, {
      item: ledgerItemView(
        item,
        selected.find((loop) => loop.id === item.loopId)!,
      ),
      outputs: (await deps.outputs.byItem(item.id)).filter((output) => output.loopId === item.loopId),
    });
  }
  const requestedFilter = ctx.url.searchParams.get("filter");
  if (requestedFilter !== null && !["all", "human", "triaged"].includes(requestedFilter))
    return sendJson(ctx.res, 400, { error: "invalid_filter" });
  const savedFilter = requestedFilter ?? (await preferences.get(uiStateId(acting.actorId, "inbox-filter")))?.value;
  const inboxFilter = savedFilter === "all" || savedFilter === "triaged" ? savedFilter : "human";
  const handled = ctx.url.searchParams.get("view") === "handled";
  const sent = ctx.url.searchParams.get("view") === "sent";
  const filter = ctx.url.searchParams.get("loopId");
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
  const loopsById = new Map(selected.map((loop) => [loop.id, loop]));
  const attentionIds = new Set(attention.map((item) => item.id));
  const members = open.filter((item) => {
    const groupId = item.triage?.groupId;
    const loop = loopsById.get(item.loopId);
    return !attentionIds.has(item.id) && groupId && attentionIds.has(groupId) && loop && consolidates(loop);
  });
  const counts = new Map<string, number>();
  for (const item of open) counts.set(item.loopId, (counts.get(item.loopId) ?? 0) + 1);
  let candidates = [...attention, ...members];
  if (sent)
    candidates = summaries.filter(
      (item) =>
        item.actionKind === "send" && item.status === "shipped" && (item.source === "gmail" || item.source === "slack"),
    );
  else if (handled) candidates = summaries.filter((item) => item.status === "shipped" || item.status === "skipped");
  const keys = triageKeys(
    candidates,
    (item) => loopsById.get(item.loopId),
    (item) => item.createdAt,
  );
  let feed = candidates
    .filter((item) => !filter || item.loopId === filter)
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
  sendJson(ctx.res, 200, {
    selected: await Promise.all(
      selected.map(async (loop) => ({
        id: loop.id,
        name: loop.name,
        icon: loop.icon,
        sources: [
          ...new Set([
            ...(loop.sources ?? []),
            ...summaries
              .filter((item) => item.loopId === loop.id)
              .flatMap((item) => (item.source ? [item.source] : [])),
          ]),
        ],
        count: counts.get(loop.id) ?? 0,
        state: loop.state,
        cronId: loop.cronId,
        syncCron: loop.cronId ? cronSummary((await deps.crons?.get(loop.cronId)) ?? null) : null,
        ingestionActive: (await ctx.deps.loopIngress?.list(loop.id))?.some((source) => source.enabled) ?? false,
        source: loop.surface?.startsWith("inbox:") ? loop.sources?.[0] : undefined,
        prioritize: prioritizes(loop),
        consolidate: consolidates(loop),
      })),
    ),
    available: available.map((loop) => ({
      id: loop.id,
      name: loop.name,
      icon: loop.icon,
      sources: loop.sources,
      source: loop.surface?.startsWith("inbox:") ? loop.sources?.[0] : undefined,
      selected: selectedIds.includes(loop.id),
    })),
    migrationPending: !migrated,
    filter: inboxFilter,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    items: page.map((item) =>
      ledgerItemView(
        {
          ...item,
          sourcePayload: item.inboxPreview ?? {
            title: item.sourceSummary ?? "Review item",
            snippet: item.parkedReason ?? item.sourceSummary ?? "",
          },
        },
        loopsById.get(item.loopId)!,
      ),
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

export const inboxRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/inbox", auth: "source", handle: inbox },
  { method: "GET", path: "/v1/inbox/access", auth: "source", handle: access },
  { method: "PUT", path: "/v1/inbox", auth: "source", handle: inbox },
];
