import { migrateInbox } from "../../loops/inbox-migration.ts";
import { scopeId, type Loop } from "../../types.ts";
import { ensureDefaultInboxLoops, findInboxLoop } from "../../loops/inbox-loop.ts";
import { ledgerItemView } from "../../loops/ledger-view.ts";
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
  const summaries = (await deps.items.summaries(selectedIds)).filter(
    (item) => selectedIds.includes(item.loopId) && item.inboxPreview?.sentChat !== true,
  );
  const itemId = ctx.url.searchParams.get("itemId");
  if (itemId) {
    const item = await deps.items.get(itemId);
    if (!item || !selectedIds.includes(item.loopId)) return sendJson(ctx.res, 404, { error: "not_found" });
    return sendJson(ctx.res, 200, {
      item: ledgerItemView(item),
      outputs: (await deps.outputs.byItem(item.id)).filter((output) => output.loopId === item.loopId),
    });
  }
  const handled = ctx.url.searchParams.get("view") === "handled";
  const sent = ctx.url.searchParams.get("view") === "sent";
  const filter = ctx.url.searchParams.get("loopId");
  const attention = summaries.filter(
    (item) => item.status === "ready" || (item.status === "failed" && item.parkedReason),
  );
  const counts = new Map<string, number>();
  for (const item of attention.filter((entry) => entry.inboxPreview?.probablyResolved !== true))
    counts.set(item.loopId, (counts.get(item.loopId) ?? 0) + 1);
  let candidates = attention;
  if (sent)
    candidates = summaries.filter(
      (item) =>
        item.actionKind === "send" && item.status === "shipped" && (item.source === "gmail" || item.source === "slack"),
    );
  else if (handled) candidates = summaries.filter((item) => item.status === "shipped" || item.status === "skipped");
  let feed = candidates
    .filter((item) => !filter || item.loopId === filter)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1;
    });
  const cursor = ctx.url.searchParams.get("cursor");
  if (cursor) {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      return sendJson(ctx.res, 400, { error: "invalid_cursor" });
    }
    if (!isObj(value) || typeof value.at !== "number" || typeof value.id !== "string")
      return sendJson(ctx.res, 400, { error: "invalid_cursor" });
    const at = value.at;
    const key = value.id;
    feed = feed.filter((item) => item.createdAt < at || (item.createdAt === at && item.id < key));
  }
  const page = feed.slice(0, 40);
  const last = page.at(-1);
  sendJson(ctx.res, 200, {
    selected: await Promise.all(
      selected.map(async (loop) => ({
        id: loop.id,
        name: loop.name,
        count: counts.get(loop.id) ?? 0,
        state: loop.state,
        cronId: loop.cronId,
        syncCron: loop.cronId ? cronSummary((await deps.crons?.get(loop.cronId)) ?? null) : null,
        ingestionActive: (await ctx.deps.loopIngress?.list(loop.id))?.some((source) => source.enabled) ?? false,
        source: loop.surface?.startsWith("inbox:") ? loop.sources?.[0] : undefined,
      })),
    ),
    available: available.map((loop) => ({ id: loop.id, name: loop.name, selected: selectedIds.includes(loop.id) })),
    migrationPending: !migrated,
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
      feed.length > page.length && last
        ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url")
        : null,
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
