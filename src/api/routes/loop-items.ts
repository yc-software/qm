import type { Cron, Loop, LoopItem, LoopSourcePayload } from "../../types.ts";
import { canonicalJson } from "../../util/objects.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { loadAdministrable, loopDeps, actingPrincipal, type LoopServiceDeps } from "./loops.ts";
import { parseScopeId } from "../../types.ts";
import { isLedgerState, ledgerItemView, ledgerState, sortLedgerItems } from "../../loops/ledger-view.ts";
import type { IngestEntryInput } from "../../loops/item-ledger.ts";
import { adapterForItem, sourceAdapter } from "../../loops/sources/index.ts";
import {
  ensureInboxLoop,
  findInboxLoop,
  INBOX_LEDGER_MAX_ITEMS,
  INBOX_LEDGER_RETENTION_MS,
  INBOX_SYNC_CRON_TITLE,
  INBOX_SYNC_DEFAULT_EVERY_MS,
  INBOX_SYNC_TASK_VERSION,
  renderInboxSyncTask,
} from "../../loops/inbox-loop.ts";
import { principalDestination } from "../../reach/reach.ts";

const MAX_ITEMS_PER_INGEST = 50;
const MAX_SOURCE_PAYLOAD_BYTES = 64_000;
const MAX_PROPOSAL_BYTES = 32_000;
const MAX_FOLLOWUP_CHARS = 4_000;
const MAX_EXTERNAL_REPLY_CHARS = 500;

function jsonSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function parseIngestEntry(loop: Loop, raw: unknown): IngestEntryInput | { error: string } {
  if (!isObj(raw)) return { error: "item must be an object" };
  const adapter = sourceAdapter(raw.source);
  if (adapter) {
    if (loop.sources && !loop.sources.includes(adapter.id)) {
      return { error: `this loop does not accept "${adapter.id}" items` };
    }
    const parsed = adapter.parse(raw);
    if ("error" in parsed) return parsed;
    return {
      loopId: loop.id,
      dedupeKey: parsed.dedupeKey,
      source: adapter.id,
      summary: parsed.summary,
      sourcePayload: parsed.sourcePayload,
      sourceAt: parsed.sourceAt,
      ...(parsed.proposal ? { proposal: { ...parsed.proposal, by: "agent" as const } } : {}),
    };
  }
  if (typeof raw.source === "string" && raw.source.trim()) {
    return { error: `unknown source "${raw.source}"` };
  }
  const dedupeKey = typeof raw.dedupeKey === "string" ? raw.dedupeKey.trim() : "";
  if (!dedupeKey || dedupeKey.length > 300) return { error: "dedupeKey (<=300 chars) required" };
  if (!isObj(raw.sourcePayload)) return { error: "sourcePayload must be an object" };
  if (jsonSize(raw.sourcePayload) > MAX_SOURCE_PAYLOAD_BYTES) {
    return { error: `sourcePayload must be under ${MAX_SOURCE_PAYLOAD_BYTES} bytes of JSON` };
  }
  const sourceAt =
    typeof raw.sourceAt === "number" && Number.isFinite(raw.sourceAt) && raw.sourceAt > 0 ? raw.sourceAt : undefined;
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim().slice(0, 500) : undefined;
  let proposal: { data: LoopSourcePayload } | undefined;
  if (raw.proposal !== undefined) {
    const data = isObj(raw.proposal) && isObj(raw.proposal.data) ? raw.proposal.data : raw.proposal;
    if (!isObj(data)) return { error: "proposal must be an object" };
    if (jsonSize(data) > MAX_PROPOSAL_BYTES) {
      return { error: `proposal must be under ${MAX_PROPOSAL_BYTES} bytes of JSON` };
    }
    proposal = { data };
  }
  return {
    loopId: loop.id,
    dedupeKey,
    sourcePayload: raw.sourcePayload,
    ...(summary !== undefined ? { summary } : {}),
    ...(sourceAt !== undefined ? { sourceAt } : {}),
    ...(proposal ? { proposal: { ...proposal, by: "agent" as const } } : {}),
  };
}

function readableItems(ctx: ApiCtx, loop: Loop): boolean {
  if (!ctx.capability || parseScopeId(loop.ownerScopeId).kind !== "personal") return true;
  if (ctx.capability.privateScope === true) return true;
  sendJson(ctx.res, 403, {
    error: "forbidden",
    message: "a personal loop's items are reachable only from its owner's own scope",
  });
  return false;
}

async function listItems(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  if (!readableItems(ctx, loop)) return;
  const wanted = ctx.url.searchParams.get("state");
  if (wanted !== null && !isLedgerState(wanted)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "unknown state filter" });
  }
  const all = sortLedgerItems(await deps.items.byLoop(loop.id));
  const items = wanted === null ? all : all.filter((item) => ledgerState(item) === wanted);
  const counts: Record<string, number> = {};
  for (const item of all) {
    const state = ledgerState(item);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  sendJson(ctx.res, 200, { loop, items: items.map(ledgerItemView), counts });
}

async function ingestItems(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  if (!ctx.capability) {
    return sendJson(ctx.res, 403, { error: "forbidden", message: "ledger items are ingested by the agent" });
  }
  if (!readableItems(ctx, loop)) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "items (non-empty array) required" });
  }
  if (body.items.length > MAX_ITEMS_PER_INGEST) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `at most ${MAX_ITEMS_PER_INGEST} items per call` });
  }
  const sessionId = ctx.capability.threadRef
    ? ((await ctx.deps.sessions?.getByThread(ctx.capability.threadRef))?.id ?? undefined)
    : undefined;
  const entries: IngestEntryInput[] = [];
  for (const [at, raw] of body.items.entries()) {
    const parsed = parseIngestEntry(loop, raw);
    if ("error" in parsed) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: `items[${at}]: ${parsed.error}` });
    }
    entries.push(sessionId && parsed.proposal ? { ...parsed, proposal: { ...parsed.proposal, sessionId } } : parsed);
  }
  const outcome = await deps.items.ingest(entries);
  await deps.items.prune(loop.id, { maxItems: INBOX_LEDGER_MAX_ITEMS, retentionMs: INBOX_LEDGER_RETENTION_MS });
  sendJson(ctx.res, 200, outcome);
}

async function loadItem(
  ctx: ApiCtx,
): Promise<{ deps: LoopServiceDeps; loop: Loop; item: LoopItem; actorId: string } | null> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return null;
  if (!readableItems(ctx, loaded.loop)) return null;
  const item = await loaded.deps.items.get(ctx.params.itemId ?? "");
  if (!item || item.loopId !== loaded.loop.id) {
    sendJson(ctx.res, 404, { error: "not_found", message: "no such ledger item" });
    return null;
  }
  return { deps: loaded.deps, loop: loaded.loop, item, actorId: loaded.acting.actorId };
}

const IMAGE_MAX_BYTES = 8_000_000;

function imageUrlFromItem(item: LoopItem, ctxIndex: number, imageIndex: number): string | null {
  const payload = item.sourcePayload ?? {};
  let list: unknown;
  if (ctxIndex === -1) {
    list = payload.images;
  } else if (Array.isArray(payload.context) && isObj(payload.context[ctxIndex])) {
    list = (payload.context[ctxIndex] as { images?: unknown }).images;
  }
  if (!Array.isArray(list)) return null;
  const url = list[imageIndex];
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

async function serveItemImage(ctx: ApiCtx): Promise<void> {
  const loaded = await loadItem(ctx);
  if (!loaded) return;
  const { loop, item } = loaded;
  const ctxIndex = Number.parseInt(ctx.url.searchParams.get("ctx") ?? "", 10);
  const imageIndex = Number.parseInt(ctx.url.searchParams.get("i") ?? "", 10);
  if (!Number.isInteger(ctxIndex) || !Number.isInteger(imageIndex) || imageIndex < 0 || ctxIndex < -1) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "ctx and i required" });
  }
  const url = imageUrlFromItem(item, ctxIndex, imageIndex);
  if (!url) return sendJson(ctx.res, 404, { error: "not_found", message: "no such image on this item" });
  const host = new URL(url).hostname;
  const slackHosted = host === "slack.com" || host.endsWith(".slack.com");
  let authHeader: Record<string, string> = {};
  if (slackHosted) {
    const tokens = ctx.deps.loopSourceTokens;
    const token = tokens
      ? ((await tokens.connectorAccessToken("slack.com", loop.owner, "personal")) ??
        (await tokens.connectorAccessToken("slack.com", loop.owner)))
      : null;
    if (!token) return sendJson(ctx.res, 502, { error: "not_connected", message: "Slack is not connected" });
    authHeader = { authorization: `Bearer ${token}` };
  }
  let upstream: Response;
  try {
    upstream = await fetch(url, { headers: authHeader, redirect: "follow" });
  } catch (e) {
    return sendJson(ctx.res, 502, { error: "upstream", message: errMessage(e) });
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !upstream.body || !type.startsWith("image/")) {
    return sendJson(ctx.res, 502, { error: "upstream", message: `upstream returned ${upstream.status} ${type}` });
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > IMAGE_MAX_BYTES) return sendJson(ctx.res, 502, { error: "upstream", message: "image too large" });
  ctx.res.writeHead(200, {
    "content-type": type,
    "content-length": String(bytes.length),
    "cache-control": "private, max-age=3600",
  });
  ctx.res.end(bytes);
}

async function getItem(ctx: ApiCtx): Promise<void> {
  const loaded = await loadItem(ctx);
  if (!loaded) return;
  sendJson(ctx.res, 200, { item: ledgerItemView(loaded.item) });
}

function sameProposalData(item: LoopItem, data: LoopSourcePayload): boolean {
  return item.proposal !== undefined && canonicalJson(item.proposal.data) === canonicalJson(data);
}

function proposalFrom(item: LoopItem, raw: unknown): LoopSourcePayload | null {
  const adapter = adapterForItem(item);
  const data = isObj(raw) && isObj(raw.data) ? raw.data : raw;
  if (!isObj(data)) return null;
  if (jsonSize(data) > MAX_PROPOSAL_BYTES) return null;
  return adapter ? adapter.parseProposal(data) : data;
}

async function actOnItem(ctx: ApiCtx): Promise<void> {
  const loaded = await loadItem(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  let item = loaded.item;
  const body = isObj(ctx.body) ? ctx.body : {};
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  const proposalAuthor = ctx.capability ? ("agent" as const) : ("human" as const);
  if (!kind) return sendJson(ctx.res, 400, { error: "bad_request", message: "kind required" });
  const args = isObj(body.args) ? body.args : {};

  const expectedAt = typeof args.expectedProposalAt === "number" ? args.expectedProposalAt : undefined;
  const draftChanged = (): void =>
    sendJson(ctx.res, 409, {
      error: "conflict",
      message: "the draft changed since you last saw it; review the new draft before sending",
    });

  if (kind === "edit") {
    const data = proposalFrom(item, args.proposal ?? args);
    if (!data) return sendJson(ctx.res, 400, { error: "bad_request", message: "proposal is not valid for this item" });
    if (expectedAt !== undefined && item.proposal && item.proposal.at !== expectedAt) return draftChanged();
    if (sameProposalData(item, data)) return sendJson(ctx.res, 200, { item: ledgerItemView(item) });
    const next = await deps.items.setProposal(
      item.id,
      { data, by: proposalAuthor },
      expectedAt !== undefined ? { expectedAt } : undefined,
    );
    if (!next && expectedAt !== undefined) return draftChanged();
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "this item is already actioned" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next) });
  }

  if (kind === "dismiss") {
    const next = await deps.items.recordAction(item.id, { kind, outcome: "dismissed" });
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "this item is already actioned" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next) });
  }

  if (kind === "reopen") {
    const next = await deps.items.reopen(item.id);
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "this item is not dismissed" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next) });
  }

  if (kind === "replied") {
    const text = typeof args.text === "string" ? args.text.trim().slice(0, MAX_EXTERNAL_REPLY_CHARS) : "";
    const next = await deps.items.recordAction(item.id, {
      kind,
      outcome: "dismissed",
      ...(text ? { result: text } : {}),
    });
    if (!next) {
      return sendJson(ctx.res, 409, { error: "conflict", message: "this item was already actioned from here" });
    }
    return sendJson(ctx.res, 200, { item: ledgerItemView(next) });
  }

  if (ledgerState(item) === "actioned") {
    return sendJson(ctx.res, 409, { error: "already_actioned", message: "this item was already actioned" });
  }

  if (expectedAt !== undefined && item.proposal && item.proposal.at !== expectedAt) return draftChanged();

  if (args.proposal !== undefined) {
    const data = proposalFrom(item, args.proposal);
    if (!data) return sendJson(ctx.res, 400, { error: "bad_request", message: "proposal is not valid for this item" });
    if (!sameProposalData(item, data)) {
      const revised = await deps.items.setProposal(
        item.id,
        { data, by: proposalAuthor },
        expectedAt !== undefined ? { expectedAt } : undefined,
      );
      if (!revised && expectedAt !== undefined) return draftChanged();
      item = revised ?? item;
    }
  }

  const adapter = adapterForItem(item);
  if (adapter?.actions.includes(kind)) {
    const tokens = ctx.deps.loopSourceTokens;
    if (!tokens) return sendJson(ctx.res, 404, { error: "not_found", message: "connectors are not wired" });
    const slackClient = ctx.deps.loopSlackClient;
    const result = await adapter.act(
      { owner: loop.owner, actor: proposalAuthor, tokens, ...(slackClient ? { slackClient } : {}) },
      item,
      kind,
      args,
    );
    if (!result.ok) {
      if (result.partial) await deps.items.appendThread(item.id, [{ role: "system", text: result.message }]);
      const statusByReason = { not_connected: 409, bad_item: 400, upstream: 502 } as const;
      return sendJson(ctx.res, statusByReason[result.reason], { error: result.reason, message: result.message });
    }
    if (result.payloadPatch) item = (await deps.items.annotate(item.id, result.payloadPatch)) ?? item;
    if (result.resolves === false) return sendJson(ctx.res, 200, { item: ledgerItemView(item) });
    const next = await deps.items.recordAction(item.id, { kind, outcome: "actioned", result: result.result });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next ?? item) });
  }

  if (!deps.fire) return sendJson(ctx.res, 404, { error: "not_found", message: "loop firing is not wired" });
  const turn = await deps.fire.itemAction(loop, item, kind, args);
  if (!turn.ok) {
    return sendJson(ctx.res, 502, { error: "action_failed", message: turn.userNote ?? "the agent turn did not run" });
  }
  await deps.items.appendThread(item.id, [{ role: "agent", text: turn.reply ?? `Did "${kind}".` }]);
  const next = await deps.items.recordAction(item.id, {
    kind,
    outcome: "actioned",
    ...(turn.reply ? { result: turn.reply } : {}),
  });
  sendJson(ctx.res, 200, { item: ledgerItemView(next ?? item) });
}

async function followUpOnItem(ctx: ApiCtx): Promise<void> {
  const loaded = await loadItem(ctx);
  if (!loaded) return;
  const { deps, loop, item } = loaded;
  const body = isObj(ctx.body) ? ctx.body : {};
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return sendJson(ctx.res, 400, { error: "bad_request", message: "message required" });
  if (message.length > MAX_FOLLOWUP_CHARS) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `message must be under ${MAX_FOLLOWUP_CHARS} chars`,
    });
  }
  if (!deps.fire) return sendJson(ctx.res, 404, { error: "not_found", message: "loop firing is not wired" });
  try {
    const next = await deps.fire.followUp(loop, item, message, loaded.actorId);
    sendJson(ctx.res, 200, { item: ledgerItemView(next ?? item) });
  } catch (e) {
    sendJson(ctx.res, 502, { error: "followup_failed", message: errMessage(e) });
  }
}

function syncTaskVersionOf(cron: Cron | null): number | null {
  const m = /^Inbox sync v(\d+)\./.exec(cron?.action ?? "");
  return m ? Number(m[1]) : null;
}

function cronSummary(cron: Cron | null): {
  id: string;
  enabled: boolean;
  schedule: Cron["schedule"];
  lastFiredAt?: number;
  taskVersion: number | null;
  currentTaskVersion: number;
} | null {
  if (!cron) return null;
  return {
    id: cron.id,
    enabled: cron.enabled,
    schedule: cron.schedule,
    ...(cron.lastFiredAt !== undefined ? { lastFiredAt: cron.lastFiredAt } : {}),
    taskVersion: syncTaskVersionOf(cron),
    currentTaskVersion: INBOX_SYNC_TASK_VERSION,
  };
}

async function getInboxLoop(ctx: ApiCtx): Promise<void> {
  const deps = loopDeps(ctx);
  if (!deps) return sendJson(ctx.res, 404, { error: "not_found", message: "loops are not wired on this deployment" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  const loop = await findInboxLoop(deps.store, acting.actorId);
  const cron = loop?.cronId ? await ctx.app.getCron(loop.cronId) : null;
  sendJson(ctx.res, 200, { loop, syncCron: cronSummary(cron) });
}

async function ensureInboxSyncCron(ctx: ApiCtx): Promise<void> {
  const deps = loopDeps(ctx);
  if (!deps) return sendJson(ctx.res, 404, { error: "not_found", message: "loops are not wired on this deployment" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const everyMs =
    typeof body.everyMs === "number" && Number.isFinite(body.everyMs)
      ? Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000 - 1, Math.floor(body.everyMs)))
      : INBOX_SYNC_DEFAULT_EVERY_MS;
  const enable = body.enabled !== false;
  const owner = acting.actorId;
  try {
    const loop = await ensureInboxLoop(deps.store, owner);
    const existing = loop.cronId ? await ctx.app.getCron(loop.cronId) : null;
    if (existing) {
      if (!enable) {
        await ctx.app.setCronEnabled(existing.id, false);
      } else {
        if (syncTaskVersionOf(existing) !== INBOX_SYNC_TASK_VERSION) {
          await ctx.app.updateCron(existing.id, {
            action: renderInboxSyncTask(loop.id),
            title: INBOX_SYNC_CRON_TITLE,
          });
        }
        if (!existing.enabled) await ctx.app.setCronEnabled(existing.id, true);
      }
      return sendJson(ctx.res, 200, { loop, syncCron: cronSummary(await ctx.app.getCron(existing.id)) });
    }
    if (!enable) return sendJson(ctx.res, 200, { loop, syncCron: null });
    const destination = principalDestination(owner, owner);
    const cron = await ctx.app.createCron({
      ownerScopeId: destination.audienceScopeId ?? `personal:${owner}`,
      owner,
      createdBy: owner,
      destination,
      schedule: { everyMs },
      title: INBOX_SYNC_CRON_TITLE,
      action: renderInboxSyncTask(loop.id),
    });
    const updated = (await deps.store.update(loop.id, { cronId: cron.id })) ?? loop;
    sendJson(ctx.res, 200, { loop: updated, syncCron: cronSummary(cron) });
  } catch (err) {
    sendJson(ctx.res, 400, { error: "bad_request", message: errMessage(err) });
  }
}

export const loopItemRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/loops/inbox", auth: "either", handle: getInboxLoop },
  { method: "POST", path: "/v1/loops/inbox/sync-cron", auth: "source", handle: ensureInboxSyncCron },
  { method: "GET", path: "/v1/loops/:id/items", auth: "either", handle: listItems },
  { method: "POST", path: "/v1/loops/:id/items", auth: "either", handle: ingestItems },
  { method: "GET", path: "/v1/loops/:id/items/:itemId", auth: "either", handle: getItem },
  { method: "GET", path: "/v1/loops/:id/items/:itemId/image", auth: "source", handle: serveItemImage },
  { method: "POST", path: "/v1/loops/:id/items/:itemId/action", auth: "either", handle: actOnItem },
  { method: "POST", path: "/v1/loops/:id/items/:itemId/followup", auth: "either", handle: followUpOnItem },
];
