import type { Loop } from "../../loops/types.ts";
import type { LoopItemSummary } from "../../loops/item-ledger.ts";
import { ensureDefaultInboxLoops, inboxSource } from "../../loops/inbox-loop.ts";
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
import { actingPrincipal, canAdministerLoop, forInboxLoopsPeople, inboxPreviewEnabled, loopDeps } from "./loops.ts";
import { cronSummary } from "./loop-items.ts";
import { isObj } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";

interface InboxView {
  status: number;
  body: Record<string, unknown>;
}

function reply(status: number, body: Record<string, unknown>): InboxView {
  return { status, body };
}

type InboxFilter = "human" | "all" | "triaged";

function inboxItemVisible(item: Pick<LoopItemSummary, "verdict" | "sourcePayload">, filter: InboxFilter): boolean {
  const state = item.verdict?.state;
  if (!state) return typeof item.sourcePayload?.snippet === "string" && item.sourcePayload.snippet !== "";
  if (state === "needs_reply") return true;
  if (state === "resolved") return filter !== "triaged";
  return filter === "all";
}

async function selectedLoopView(
  ctx: ApiCtx,
  deps: NonNullable<ReturnType<typeof loopDeps>>,
  loop: Loop,
  summaries: Array<{ loopId: string; source?: string }>,
  counts: Map<string, number>,
): Promise<Record<string, unknown>> {
  return {
    id: loop.id,
    name: loop.name,
    icon: loop.icon,
    sources: [
      ...new Set([
        ...(loop.sources ?? []),
        ...summaries.filter((item) => item.loopId === loop.id).flatMap((item) => (item.source ? [item.source] : [])),
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
  };
}

export async function inboxView(ctx: ApiCtx): Promise<InboxView | null> {
  const deps = loopDeps(ctx);
  const preferences = ctx.deps.uiState;
  if (!deps || !preferences) return reply(503, { error: "inbox_unavailable" });
  const acting = actingPrincipal(ctx);
  if (!acting) return null;
  if (!(await inboxPreviewEnabled(ctx.deps, acting.actorId))) return reply(403, { error: "feature_disabled" });
  if (ctx.capability && ctx.capability.privateScope !== true) return reply(403, { error: "forbidden" });
  const defaults = await ensureDefaultInboxLoops(deps.store, acting.actorId);
  const id = uiStateId(acting.actorId, "inbox-loops");
  const pref = await preferences.putIfAbsent(id, {
    value: defaults.map((loop) => loop.id),
    updatedAt: Date.now(),
  });
  const available: Loop[] = [];
  for (const loop of await deps.store.list()) {
    if (loop.state !== "archived" && (await canAdministerLoop(ctx.app, loop, acting))) available.push(loop);
  }
  let ids = Array.isArray(pref.value) ? pref.value.filter((value): value is string => typeof value === "string") : [];
  if (ctx.method === "POST") {
    const body = isObj(ctx.body) ? ctx.body : {};
    if (
      !Array.isArray(body.loopIds) ||
      body.loopIds.length > 100 ||
      body.loopIds.some((value) => typeof value !== "string")
    ) {
      return reply(400, { error: "invalid_selection" });
    }
    ids = [...new Set(body.loopIds as string[])];
    if (ids.some((value) => !available.some((loop) => loop.id === value))) return reply(403, { error: "forbidden" });
    await preferences.put(id, { value: ids, updatedAt: Date.now() });
  }
  const selected = ids.flatMap((value) => available.filter((loop) => loop.id === value));
  const selectedIds = selected.map((loop) => loop.id);
  const summaries = (await deps.items.summaries(selectedIds)).filter(
    (item) => selectedIds.includes(item.loopId) && item.sourcePayload?.sentChat !== true,
  );
  const itemId = ctx.url.searchParams.get("itemId");
  if (itemId) {
    const item = await deps.items.get(itemId);
    if (!item || !selectedIds.includes(item.loopId)) return reply(404, { error: "not_found" });
    return reply(200, {
      item: ledgerItemView(
        item,
        selected.find((loop) => loop.id === item.loopId)!,
      ),
      outputs: (await deps.outputs.byItem(item.id)).filter((output) => output.loopId === item.loopId),
    });
  }
  const requestedFilter = ctx.url.searchParams.get("filter");
  if (requestedFilter !== null && !["all", "human", "triaged"].includes(requestedFilter))
    return reply(400, { error: "invalid_filter" });
  const savedFilter = requestedFilter ?? (await preferences.get(uiStateId(acting.actorId, "inbox-filter")))?.value;
  const inboxFilter: InboxFilter = savedFilter === "all" || savedFilter === "triaged" ? savedFilter : "human";
  const loopsById = new Map(selected.map((loop) => [loop.id, loop]));
  const handled = ctx.url.searchParams.get("view") === "handled";
  const sent = ctx.url.searchParams.get("view") === "sent";
  const filter = ctx.url.searchParams.get("loopId");
  const open = summaries.filter((item) => !isResolved(item));
  const attention = open.filter((item) => {
    if (loopsById.get(item.loopId) && inboxSource(loopsById.get(item.loopId)!))
      return inboxItemVisible(item, inboxFilter);
    return item.status === "ready" || (item.status === "failed" && Boolean(item.parkedReason));
  });
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
      return reply(400, { error: "invalid_cursor" });
    }
    if (!Array.isArray(value) || value.some((part) => typeof part !== "number" && typeof part !== "string"))
      return reply(400, { error: "invalid_cursor" });
    const after = value as Array<number | string>;
    feed = feed.filter((item) => compareKeys(keys.get(item.id)!, after) > 0);
  }
  const page = feed.slice(0, 40);
  const last = page.at(-1);
  return reply(200, {
    selected: await Promise.all(selected.map((loop) => selectedLoopView(ctx, deps, loop, summaries, counts))),
    available: available.map((loop) => ({
      id: loop.id,
      name: loop.name,
      icon: loop.icon,
      sources: loop.sources,
      source: loop.surface?.startsWith("inbox:") ? loop.sources?.[0] : undefined,
      selected: selectedIds.includes(loop.id),
    })),
    filter: inboxFilter,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    items: page.map((item) =>
      ledgerItemView(
        {
          ...item,
          sourcePayload: item.sourcePayload ?? {
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

async function inbox(ctx: ApiCtx): Promise<void> {
  const view = await inboxView(ctx);
  if (view) sendJson(ctx.res, view.status, view.body);
}

export const inboxRoutes: ReadonlyArray<Route<ApiCtx>> = withActor(
  "query.principalId",
  forInboxLoopsPeople([
    { method: "GET", path: "/v1/inbox", auth: "source", handle: inbox },
    { method: "POST", path: "/v1/inbox/selection", auth: "source", handle: inbox },
  ]),
);
