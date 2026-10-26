import { z } from "zod";
import type { Cron, InboxItem, InboxPayload } from "../../types.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import { isAccountType } from "../../connectors/oauth.ts";
import { canonicalJson } from "../../../cli/src/canonical-json.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { canAdministerCron } from "../control-service.ts";
import { unattendedGrantRefusal } from "../../cron/authority.ts";
import { scopeId, parseScopeId } from "../../types.ts";
import { isResolved, isLedgerState, ledgerItemView, ledgerState, sortLedgerItems } from "../../inbox/view.ts";
import { inboxItemId, type IngestEntryInput, type InboxEventSink, type InboxLedger } from "../../inbox/ledger.ts";
import type { InboxChat } from "../../inbox/item-chat.ts";
import { addressList } from "../../inbox/sources/adapter.ts";
import { adapterForItem, sourceAdapter } from "../../inbox/sources/index.ts";
import {
  ensureInboxCron,
  renderSourceInboxTask,
  inboxCrons,
  inboxName,
  INBOX_SOURCES,
  INBOX_LEDGER_MAX_ITEMS,
  INBOX_LEDGER_RETENTION_MS,
  INBOX_SYNC_DEFAULT_EVERY_MS,
} from "../../inbox/sync-task.ts";
import { THINKING_LEVELS, isHarnessId } from "../../model/pi-models.ts";
import type { AdvisoryLock } from "../../persistence/advisory-lock.ts";
import type { CronStore } from "../../cron/cron-store.ts";

export interface InboxServiceDeps {
  items: InboxLedger;
  chat?: InboxChat;
  record: InboxEventSink;
  lock?: AdvisoryLock;
}

export function inboxDeps(ctx: ApiCtx): InboxServiceDeps | null {
  return ctx.deps.inbox ?? null;
}

interface ActingPrincipal {
  actorId: string;
  capability?: CapabilityClaims;
}

export function actingPrincipal(ctx: ApiCtx): ActingPrincipal | null {
  if (ctx.capability) return { actorId: ctx.capability.actorId, capability: ctx.capability };
  if (ctx.actor?.p) return { actorId: ctx.actor.p };
  const principalId = (ctx.url.searchParams.get("principalId") ?? "").trim();
  if (principalId) return { actorId: principalId };
  sendJson(ctx.res, 403, { error: "forbidden", message: "inbox routes need an agent capability or a principalId" });
  return null;
}

export function appCrons(ctx: ApiCtx): Pick<CronStore, "list" | "create"> {
  return { list: () => ctx.app.listCrons(), create: (input) => ctx.app.createCron(input) };
}

async function loadInboxCron(
  ctx: ApiCtx,
): Promise<{ deps: InboxServiceDeps; cron: Cron; acting: ActingPrincipal } | null> {
  const deps = inboxDeps(ctx);
  if (!deps) {
    sendJson(ctx.res, 404, { error: "not_found", message: "inboxes are not wired on this deployment" });
    return null;
  }
  const acting = actingPrincipal(ctx);
  if (!acting) return null;
  const cron = await ctx.app.getCron(ctx.params.id ?? "");
  if (!cron?.inbox || cron.archived || !(await canAdministerCron(ctx.app, cron, acting.actorId))) {
    sendJson(ctx.res, 404, { error: "not_found", message: "no such cron inbox" });
    return null;
  }
  return { deps, cron, acting };
}

async function requireCronAuthority(ctx: ApiCtx, cron: Cron): Promise<boolean> {
  if (!cron.unattendedGrants?.length) return true;
  const principal = ctx.capability ?? (ctx.actor?.p ? { actorId: ctx.actor.p, liveActor: true } : undefined);
  const refusal = principal
    ? await unattendedGrantRefusal(ctx.app, ctx.deps.admin, cron, principal)
    : { message: "a privileged cron requires a live turn started by its owner" };
  if (!refusal) return true;
  sendJson(ctx.res, 403, { error: "forbidden", message: refusal.message });
  return false;
}

const MAX_ITEMS_PER_INGEST = 50;
const MAX_SOURCE_PAYLOAD_BYTES = 64_000;
const MAX_PROPOSAL_BYTES = 32_000;
const MAX_FOLLOWUP_CHARS = 4_000;

const CLOSING_KINDS = new Map<string, "actioned" | "dismissed" | "failed">([
  ["dismiss", "dismissed"],
  ["replied", "dismissed"],
  ["no_reply_needed", "dismissed"],
  ["done", "actioned"],
  ["fail", "failed"],
]);

function jsonSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function parseIngestEntry(cron: Cron, raw: unknown): IngestEntryInput | { error: string } {
  if (!isObj(raw)) return { error: "item must be an object" };
  const adapter = sourceAdapter(raw.source);
  if (adapter) {
    if (cron.inbox?.source && cron.inbox.source !== adapter.id) {
      return { error: `this inbox does not accept "${adapter.id}" items` };
    }
    const parsed = adapter.parse(raw);
    if ("error" in parsed) return parsed;
    return {
      cronId: cron.id,
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
  let proposal: { data: InboxPayload } | undefined;
  if (raw.proposal !== undefined) {
    const data = isObj(raw.proposal) && isObj(raw.proposal.data) ? raw.proposal.data : raw.proposal;
    if (!isObj(data)) return { error: "proposal must be an object" };
    if (jsonSize(data) > MAX_PROPOSAL_BYTES) {
      return { error: `proposal must be under ${MAX_PROPOSAL_BYTES} bytes of JSON` };
    }
    proposal = { data };
  }
  return {
    cronId: cron.id,
    dedupeKey,
    sourcePayload: raw.sourcePayload,
    ...(summary !== undefined ? { summary } : {}),
    ...(sourceAt !== undefined ? { sourceAt } : {}),
    ...(proposal ? { proposal: { ...proposal, by: "agent" as const } } : {}),
  };
}

function readableItems(ctx: ApiCtx, cron: Cron): boolean {
  if (!ctx.capability || parseScopeId(cron.ownerScopeId).kind !== "personal") return true;
  if (ctx.capability.privateScope === true) return true;
  sendJson(ctx.res, 403, {
    error: "forbidden",
    message: "a personal inbox is reachable only from its owner's own scope",
  });
  return false;
}

async function listItems(ctx: ApiCtx): Promise<void> {
  const loaded = await loadInboxCron(ctx);
  if (!loaded) return;
  const { deps, cron } = loaded;
  if (!readableItems(ctx, cron)) return;
  const wanted = ctx.url.searchParams.get("state");
  if (wanted !== null && !isLedgerState(wanted)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "unknown state filter" });
  }
  if (cron.inbox?.source === "gmail" && cron.owner === loaded.acting.actorId) {
    const openMail = (await deps.items.byCron(cron.id)).filter(
      (item) => !isResolved(item) && (item.source ?? item.sourcePayload?.source) === "gmail",
    );
    await ctx.deps.inboxSourceRefresh?.(cron.owner, openMail);
  }
  const all = sortLedgerItems(await deps.items.byCron(cron.id));
  const items = wanted === null ? all : all.filter((item) => ledgerState(item) === wanted);
  const counts: Record<string, number> = {};
  for (const item of all) {
    const state = ledgerState(item);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  sendJson(ctx.res, 200, { items: items.map((item) => ledgerItemView(item, !!ctx.capability)), counts });
}

async function ingestItems(ctx: ApiCtx): Promise<void> {
  const loaded = await loadInboxCron(ctx);
  if (!loaded) return;
  const { deps, cron } = loaded;
  if (!ctx.capability) {
    return sendJson(ctx.res, 403, { error: "forbidden", message: "inbox items are ingested by the agent" });
  }
  if (!readableItems(ctx, cron)) return;
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
  const classifyInboxEmail =
    cron.inbox?.source === "gmail" &&
    cron.ownerScopeId === scopeId("personal", cron.owner) &&
    (await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", cron.owner))) === true;
  const entries: IngestEntryInput[] = [];
  const existingItems = await deps.items.byCron(cron.id);
  for (const [at, raw] of body.items.entries()) {
    const parsed = parseIngestEntry(cron, raw);
    if ("error" in parsed) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: `items[${at}]: ${parsed.error}` });
    }
    if (classifyInboxEmail && parsed.source === "gmail" && isObj(raw)) {
      for (const key of ["automated", "probablyResolved"])
        if (typeof raw[key] === "boolean") parsed.sourcePayload[key] = raw[key];
    }
    if (parsed.source === "slack") {
      const adapter = sourceAdapter("slack")!;
      const existing = existingItems.find(
        (item) =>
          (item.source ?? item.sourcePayload?.source) === "slack" && adapter.matchesEvent(item, parsed.dedupeKey),
      );
      if (existing) parsed.dedupeKey = existing.sourceKey;
    }
    entries.push(sessionId && parsed.proposal ? { ...parsed, proposal: { ...parsed.proposal, sessionId } } : parsed);
  }
  const outcome = await deps.items.ingest(entries);
  await deps.items.prune(cron.id, { maxItems: INBOX_LEDGER_MAX_ITEMS, retentionMs: INBOX_LEDGER_RETENTION_MS });
  sendJson(ctx.res, 200, outcome);
}

async function loadItem(
  ctx: ApiCtx,
): Promise<{ deps: InboxServiceDeps; cron: Cron; item: InboxItem; actorId: string } | null> {
  const loaded = await loadInboxCron(ctx);
  if (!loaded) return null;
  if (!readableItems(ctx, loaded.cron)) return null;
  const item = await loaded.deps.items.get(ctx.params.itemId ?? "");
  if (!item || item.cronId !== loaded.cron.id) {
    sendJson(ctx.res, 404, { error: "not_found", message: "no such inbox item" });
    return null;
  }
  return { deps: loaded.deps, cron: loaded.cron, item, actorId: loaded.acting.actorId };
}

const IMAGE_MAX_BYTES = 8_000_000;

function imageUrlFromItem(item: InboxItem, ctxIndex: number, imageIndex: number): string | null {
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
  const { cron, item } = loaded;
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
    const tokens = ctx.deps.inboxSourceTokens;
    const token = tokens
      ? ((await tokens.connectorAccessToken("slack.com", cron.owner, "personal")) ??
        (await tokens.connectorAccessToken("slack.com", cron.owner)))
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
  if (
    ctx.url.searchParams.get("refreshSource") === "1" &&
    loaded.cron.inbox?.source &&
    loaded.cron.owner === loaded.actorId
  )
    await ctx.deps.inboxSourceRefresh?.(loaded.cron.owner, [loaded.item]);
  sendJson(ctx.res, 200, {
    item: ledgerItemView((await loaded.deps.items.get(loaded.item.id)) ?? loaded.item, !!ctx.capability),
  });
}

function sameProposalData(item: InboxItem, data: InboxPayload): boolean {
  return item.proposal !== undefined && canonicalJson(item.proposal.data) === canonicalJson(data);
}

function proposalFrom(item: InboxItem, raw: unknown): InboxPayload | null {
  const adapter = adapterForItem(item);
  const data = isObj(raw) && isObj(raw.data) ? raw.data : raw;
  if (!isObj(data)) return null;
  if (jsonSize(data) > MAX_PROPOSAL_BYTES) return null;
  return adapter ? adapter.parseProposal(data) : data;
}

async function actOnItem(ctx: ApiCtx): Promise<void> {
  const loaded = await loadItem(ctx);
  if (!loaded) return;
  const { deps, cron } = loaded;
  let item = loaded.item;
  const body = isObj(ctx.body) ? ctx.body : {};
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  const proposalAuthor = ctx.capability ? ("agent" as const) : ("human" as const);
  if (!kind) return sendJson(ctx.res, 400, { error: "bad_request", message: "kind required" });
  const args = isObj(body.args) ? body.args : {};

  const expectedAt = typeof args.expectedProposalAt === "number" ? args.expectedProposalAt : undefined;
  const draftChanged = (): void =>
    sendJson(ctx.res, 409, {
      error: "draft_changed",
      message: "the draft changed since you last saw it; review the new draft before sending",
    });

  if (kind === "edit") {
    const data = proposalFrom(item, args.proposal ?? args);
    if (!data) return sendJson(ctx.res, 400, { error: "bad_request", message: "proposal is not valid for this item" });
    if (expectedAt !== undefined && item.proposal && item.proposal.at !== expectedAt) return draftChanged();
    if (sameProposalData(item, data)) return sendJson(ctx.res, 200, { item: ledgerItemView(item, !!ctx.capability) });
    const next = await deps.items.setProposal(
      item.id,
      { data, by: proposalAuthor },
      expectedAt !== undefined ? { expectedAt } : undefined,
    );
    if (!next && expectedAt !== undefined) return draftChanged();
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "this item is already actioned" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next, !!ctx.capability) });
  }

  const closing = CLOSING_KINDS.get(kind);
  if (closing) {
    if (kind === "done" && adapterForItem(item))
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: "send this item's reply instead of marking it done",
      });
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 500) : "";
    const latest = isObj(item.sourcePayload?.latestEvent) ? item.sourcePayload.latestEvent : undefined;
    const ownText =
      kind === "replied" && latest?.author === "owner" && typeof latest.text === "string" ? latest.text : "";
    const result = ownText || reason;
    const next = await deps.items.recordAction(item.id, { kind, outcome: closing, ...(result ? { result } : {}) });
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "this item is already actioned" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next, !!ctx.capability) });
  }

  if (kind === "reply") {
    if (!ctx.actor?.p || item.sourcePayload?.sentChat !== true) return sendJson(ctx.res, 403, { error: "forbidden" });
    const next = await deps.items.reopen(item.id, { sentReply: true });
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "a reply is already being drafted" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next, !!ctx.capability) });
  }

  if (kind === "reopen") {
    const next = await deps.items.reopen(item.id);
    if (!next) return sendJson(ctx.res, 409, { error: "conflict", message: "this item is not dismissed" });
    return sendJson(ctx.res, 200, { item: ledgerItemView(next, !!ctx.capability) });
  }

  if (kind === "send" && item.status !== "ready") {
    return sendJson(ctx.res, 409, { error: "not_ready", message: "This item needs a fresh draft before sending" });
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
    const tokens = ctx.deps.inboxSourceTokens;
    if (!tokens) return sendJson(ctx.res, 404, { error: "not_found", message: "connectors are not wired" });
    const decisionToken = await deps.items.acquireDecision(item.id);
    if (!decisionToken)
      return sendJson(ctx.res, 409, { error: "conflict", message: "an action is already in progress" });
    try {
      const current = await deps.items.get(item.id);
      if (!current || ledgerState(current) === "actioned")
        return sendJson(ctx.res, 409, { error: "already_actioned", message: "this item was already actioned" });
      if (current.proposal?.at !== item.proposal?.at) return draftChanged();
      item = current;
      const slackClient = ctx.deps.inboxSlackClient;
      const result = await adapter.act(
        { owner: cron.owner, actor: proposalAuthor, tokens, ...(slackClient ? { slackClient } : {}) },
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
      if (result.resolves === false) return sendJson(ctx.res, 200, { item: ledgerItemView(item, !!ctx.capability) });
      const next = await deps.items.recordAction(item.id, { kind, outcome: "actioned", result: result.result });
      return sendJson(ctx.res, 200, { item: ledgerItemView(next ?? item, !!ctx.capability) });
    } finally {
      await deps.items.releaseDecision(item.id, decisionToken);
    }
  }

  sendJson(ctx.res, 400, { error: "bad_request", message: `unknown action "${kind}"` });
}

const followUpOptionsSchema = z.object({
  model: z.string().trim().min(1).optional(),
  harness: z.string().trim().refine(isHarnessId, "unsupported harness").optional(),
  thinkingLevel: z.string().trim().pipe(z.enum(THINKING_LEVELS)).optional(),
  fastMode: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1),
        blobId: z.string().min(1),
        mimetype: z.string(),
        sizeBytes: z.int().min(1).max(1_000_000_000),
      }),
    )
    .max(10)
    .optional(),
});

async function followUpOnItem(ctx: ApiCtx): Promise<void> {
  const loaded = await loadItem(ctx);
  if (!loaded) return;
  const { deps, cron, item } = loaded;
  if (!(await requireCronAuthority(ctx, cron))) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const parsed = followUpOptionsSchema.safeParse(body);
  if (!parsed.success)
    return sendJson(ctx.res, 400, { error: "bad_request", message: parsed.error.issues[0]?.message });
  const options = parsed.data;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message && !options.attachments?.length)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "message required" });
  if (message.length > MAX_FOLLOWUP_CHARS) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `message must be under ${MAX_FOLLOWUP_CHARS} chars`,
    });
  }
  if (typeof body.expectedProposalAt === "number" && item.proposal?.at !== body.expectedProposalAt) {
    return sendJson(ctx.res, 409, {
      error: "draft_changed",
      message: "the draft changed; review it before continuing",
    });
  }
  if (!deps.chat) return sendJson(ctx.res, 404, { error: "not_found", message: "inbox chat is not wired" });
  try {
    const next = await deps.chat.followUp(
      cron,
      item,
      message || "Please review the attached files.",
      loaded.actorId,
      options,
    );
    sendJson(ctx.res, 200, { item: ledgerItemView(next ?? item, !!ctx.capability) });
  } catch (e) {
    sendJson(ctx.res, 502, { error: "followup_failed", message: errMessage(e) });
  }
}

export function cronSummary(cron: Cron | null): {
  id: string;
  enabled: boolean;
  schedule: Cron["schedule"];
  lastFiredAt?: number;
} | null {
  if (!cron) return null;
  return {
    id: cron.id,
    enabled: cron.enabled,
    schedule: cron.schedule,
    ...(cron.lastFiredAt !== undefined ? { lastFiredAt: cron.lastFiredAt } : {}),
  };
}

export async function ensureSentChat(ctx: ApiCtx): Promise<void> {
  const owner = ctx.actor?.p;
  if (!owner) return sendJson(ctx.res, 403, { error: "forbidden" });
  if (!(await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", owner))))
    return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const deps = inboxDeps(ctx);
  if (!deps) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId || threadId.length > 200 || jsonSize(body) > MAX_SOURCE_PAYLOAD_BYTES)
    return sendJson(ctx.res, 400, { error: "bad_request" });
  const text = (key: string, max: number): string => (typeof body[key] === "string" ? body[key].slice(0, max) : "");
  const accountType = body.accountType === undefined ? "default" : body.accountType;
  const to = addressList(body.to === undefined ? [] : [body.to]);
  const cc = addressList(body.cc === undefined ? [] : [body.cc]);
  if (!isAccountType(accountType) || to === null || cc === null)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid account or recipient headers" });
  const payload = {
    title: text("subject", 300),
    from: text("from", 500),
    snippet: text("text", 50000),
    gmail: {
      threadId,
      accountType,
      messageId: text("messageId", 200),
      subject: text("subject", 300),
      to: to ?? [],
      cc: cc ?? [],
      rfcMessageId: text("rfcMessageId", 400),
    },
    sentChat: true,
  } as InboxPayload;
  const cron = await ensureInboxCron(appCrons(ctx), owner, "gmail");
  const dedupeKey = accountType === "default" ? `sent-chat:${threadId}` : `sent-chat:${accountType}:${threadId}`;
  let item = (await deps.items.byCron(cron.id)).find((entry) => entry.sourceKey === dedupeKey);
  const id = item?.id ?? inboxItemId(cron.id, dedupeKey);
  if (!item) {
    await deps.items.ingest([
      {
        cronId: cron.id,
        dedupeKey,
        source: "gmail",
        summary: text("subject", 300),
        proposal: { data: { body: "" }, by: "human" },
        sourcePayload: payload,
      },
    ]);
    item = (await deps.items.get(id)) ?? undefined;
  }
  if (!item) return sendJson(ctx.res, 500, { error: "chat_unavailable" });
  item = (await deps.items.annotate(id, payload, { summary: text("subject", 300) })) ?? item;
  if (item.actionKind === "sent") item = (await deps.items.reopen(id, { sentReply: true })) ?? item;
  ctx.res.setHeader("Cache-Control", "no-store");
  sendJson(ctx.res, 200, { item: ledgerItemView(item, !!ctx.capability) });
}

async function ensureInboxSyncCron(ctx: ApiCtx): Promise<void> {
  const deps = inboxDeps(ctx);
  if (!deps) return sendJson(ctx.res, 404, { error: "not_found", message: "inboxes are not wired on this deployment" });
  const acting = actingPrincipal(ctx);
  if (!acting) return;
  if (!(await ctx.deps.featureFlags?.enabled("inbox_loops", scopeId("personal", acting.actorId))))
    return sendJson(ctx.res, 403, { error: "feature_disabled" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const everyMs =
    typeof body.everyMs === "number" && Number.isFinite(body.everyMs)
      ? Math.max(5 * 60 * 1000, Math.min(24 * 60 * 60 * 1000 - 1, Math.floor(body.everyMs)))
      : INBOX_SYNC_DEFAULT_EVERY_MS;
  const enable = body.enabled !== false;
  const owner = acting.actorId;
  try {
    const existing = await inboxCrons(appCrons(ctx), owner);
    const requested = typeof body.cronId === "string" ? body.cronId : null;
    const sources = INBOX_SOURCES.filter(
      (entry) => !requested || existing.some((cron) => cron.id === requested && cron.inbox?.source === entry.source),
    );
    if (!sources.length) return sendJson(ctx.res, 404, { error: "not_found" });
    const crons: Array<ReturnType<typeof cronSummary>> = [];
    for (const { source } of sources) {
      const cron = await ensureInboxCron(appCrons(ctx), owner, source);
      const task = renderSourceInboxTask(source);
      if (enable && (cron.action !== task || cron.title !== `${inboxName(source)} sync`))
        await ctx.app.updateCron(cron.id, { action: task, title: `${inboxName(source)} sync` });
      if (enable && body.everyMs !== undefined && cron.schedule.everyMs !== everyMs)
        await ctx.app.updateCron(cron.id, { schedule: { everyMs } });
      await ctx.app.setCronEnabled(cron.id, enable);
      crons.push(cronSummary(await ctx.app.getCron(cron.id)));
    }
    sendJson(ctx.res, 200, { syncCron: crons[0], crons });
  } catch (err) {
    sendJson(ctx.res, 400, { error: "bad_request", message: errMessage(err) });
  }
}

function serializeItemAction(handler: (ctx: ApiCtx) => Promise<void>): (ctx: ApiCtx) => Promise<void> {
  return (ctx) => {
    const lock = inboxDeps(ctx)?.lock;
    return lock && !ctx.capability
      ? lock.withLock(`cron-inbox:${ctx.params.id ?? ""}`, () => handler(ctx))
      : handler(ctx);
  };
}

export const cronItemRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/inbox/sent-chat", auth: "source", handle: ensureSentChat },
  { method: "GET", path: "/v1/crons/:id/items/:itemId/image", auth: "source", handle: serveItemImage },
  ...withActor("query.principalId", [
    { method: "POST", path: "/v1/inbox/sync-cron", auth: "source", handle: ensureInboxSyncCron },
    { method: "GET", path: "/v1/crons/:id/items", auth: "either", handle: listItems },
    { method: "POST", path: "/v1/crons/:id/items", auth: "either", handle: ingestItems },
    { method: "GET", path: "/v1/crons/:id/items/:itemId", auth: "either", handle: getItem },
    {
      method: "POST",
      path: "/v1/crons/:id/items/:itemId/action",
      auth: "either",
      handle: serializeItemAction(actOnItem),
    },
    {
      method: "POST",
      path: "/v1/crons/:id/items/:itemId/followup",
      auth: "either",
      handle: serializeItemAction(followUpOnItem),
    },
  ]),
];
