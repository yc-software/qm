import type { App } from "../../app.ts";
import { personLabel } from "../../../identity/person-names.ts";
import type { ServerDeps } from "../../deps.ts";
import { parseScopeId, type Delivery, type DeliveryProvenance, type Session } from "../../../types.ts";
import {
  sessionCategory,
  type LlmRequestRecord,
  type SessionCategory,
  type SessionSummary,
} from "../../../sessions/session-store.ts";
import { createTranscriptSource } from "../../../sessions/transcript-source.ts";
import { isUserItem, type Item } from "../../../sessions/items.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { requireScopedResource } from "./common.ts";
import { activityCounts, scopeActivity } from "./scope-activity.ts";
import {
  cronOrigins,
  deliveryOrigin,
  parseSessionWakeRef,
  sessionKind,
  sessionOrigin,
  type AdminSessionOrigin,
} from "./origins.ts";

const SESSIONS_PAGE_LIMIT_MAX = 200;
const SESSIONS_PAGE_LIMIT_DEFAULT = 50;
const TRANSCRIPT_LIMIT_MAX = 50000;
const TRANSCRIPT_LIMIT_DEFAULT = 500;
async function displayNameForPrincipal(app: App, deps: ServerDeps, principalId: string): Promise<string> {
  const member = await app.directoryMember(principalId);
  const user = await deps.users?.get(principalId).catch(() => null);
  return personLabel(principalId, { displayName: member?.displayName, user });
}

async function inferSingleParticipantName(app: App, deps: ServerDeps, sessionId: string): Promise<string | null> {
  const participantIds = new Set((await deps.sessions?.participantsOf(sessionId)) ?? []);
  if (participantIds.size !== 1) return null;
  return displayNameForPrincipal(app, deps, [...participantIds][0]!);
}

function withSpeakerName(item: Item, name: string): Item {
  if (!isUserItem(item) || item.body.sourceRole === "agent" || !name.trim()) return item;
  if (typeof item.body.name === "string" && item.body.name.trim()) return item;
  return { ...item, body: { ...item.body, name } };
}

async function labelTranscriptItems(app: App, deps: ServerDeps, session: Session, items: Item[]): Promise<Item[]> {
  const fallbackName = await inferSingleParticipantName(app, deps, session.id);
  if (!fallbackName) return items;
  return items.map((item) => withSpeakerName(item, fallbackName));
}

type ProvenanceSidecar = {
  provenance: DeliveryProvenance;
  sourceSession?: Session;
  llmRequests?: LlmRequestRecord[];
};

async function deliveryProvenanceSidecars(
  deps: ServerDeps,
  deliveries: readonly Delivery[],
  requestedScope: string,
): Promise<Map<string, ProvenanceSidecar>> {
  const out = new Map<string, ProvenanceSidecar>();
  const orgWide = parseScopeId(requestedScope).kind === "org";
  const bySource = new Map<string, Delivery[]>();
  for (const d of deliveries) {
    if (!d.provenance) continue;
    const key = d.provenance.sourceSessionId ?? `thread:${d.provenance.sourceThreadRef}`;
    const group = bySource.get(key);
    if (group) group.push(d);
    else bySource.set(key, [d]);
  }
  const sources =
    (await deps.sessions?.getMany({
      ids: [...bySource.values()].flatMap((group) => group[0]!.provenance!.sourceSessionId ?? []),
      threadRefs: [...bySource.values()].flatMap((group) =>
        group[0]!.provenance!.sourceSessionId ? [] : [group[0]!.provenance!.sourceThreadRef],
      ),
    })) ?? [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  const byThread = new Map(sources.map((source) => [source.threadRef, source]));
  const allowed = [...bySource.values()].flatMap((group) => {
    const provenance = group[0]!.provenance!;
    const sourceSession = provenance.sourceSessionId
      ? byId.get(provenance.sourceSessionId)
      : byThread.get(provenance.sourceThreadRef);
    for (const d of group) out.set(d.id, { provenance: d.provenance! });
    return sourceSession && (orgWide || sourceSession.scopeId === requestedScope) ? [{ group, sourceSession }] : [];
  });
  const ranges = new Map<string, number>();
  for (const { group, sourceSession } of allowed)
    for (const d of group) {
      const seq = d.provenance!.sourceUserSeq;
      if (seq !== undefined) ranges.set(sourceSession.id, Math.min(ranges.get(sourceSession.id) ?? Infinity, seq));
    }
  const entries =
    (await deps.sessions?.userItemSeqs([...ranges].map(([sessionId, sinceSeq]) => ({ sessionId, sinceSeq })))) ?? [];
  const perDelivery = allowed.flatMap(({ group, sourceSession }) =>
    group.map((d) => {
      const p = d.provenance!;
      const turnSeqs = new Set<number>();
      if (p.sourceUserSeq !== undefined) {
        turnSeqs.add(p.sourceUserSeq);
        for (const e of entries)
          if (
            e.sessionId === sourceSession.id &&
            e.seq >= p.sourceUserSeq &&
            (p.sourceAssistantEntrySeq === undefined || e.seq <= p.sourceAssistantEntrySeq)
          )
            turnSeqs.add(e.seq);
      }
      return { d, sourceSession, turnSeqs };
    }),
  );
  const turns = perDelivery.flatMap(({ sourceSession, turnSeqs }) =>
    [...turnSeqs].map((turnSeq) => ({ sessionId: sourceSession.id, turnSeq })),
  );
  const requests = (await deps.sessions?.listLlmRequestsForTurns(turns)) ?? [];
  for (const { d, sourceSession, turnSeqs } of perDelivery) {
    const own = requests.filter(
      (r) => r.sessionId === sourceSession.id && r.turnSeq !== null && turnSeqs.has(r.turnSeq),
    );
    out.set(d.id, { provenance: d.provenance!, sourceSession, ...(own.length ? { llmRequests: own } : {}) });
  }
  return out;
}

function requireAdminSession(ctx: ApiCtx, id: string) {
  return requireScopedResource(
    ctx,
    () => ctx.deps.sessions?.get(id),
    (s) => s.scopeId,
    "session",
    "fallback",
  );
}

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

export async function listAdminSessions(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(ctx, { principalId: actor.id, action: "sessions.read", resource: "sessions", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const categoryParam = url.searchParams.get("category") ?? "conversation";
  let category: SessionCategory | "all" = "conversation";
  if (categoryParam === "background" || categoryParam === "all") category = categoryParam;
  const categoryFilter = category === "all" ? undefined : category;
  const originParam = url.searchParams.get("origin");
  const originFilter: AdminSessionOrigin | undefined =
    originParam === "cron" || originParam === "other_background" ? originParam : undefined;
  const cronId = url.searchParams.get("cron") || undefined;
  const limit = Math.min(
    SESSIONS_PAGE_LIMIT_MAX,
    Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || SESSIONS_PAGE_LIMIT_DEFAULT),
  );
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
  const cronLookup = new Map((await app.listCrons([...pageCronIds])).map((cron) => [cron.id, cron]));
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
  return sendJson(res, 200, {
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

export async function getAdminSessionLlm(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, url } = ctx;
  const id = params.id!;
  const scoped = await requireAdminSession(ctx, id);
  if (!scoped) return;
  const { actor, record: session } = scoped;
  audit(ctx, { principalId: actor.id, action: "session.llm.read", resource: id, scopeLabel: session.scopeId });
  const turnParam = url.searchParams.get("turnSeq");
  if (turnParam != null && turnParam !== "") {
    let opts: { orphans: true } | { turnSeqs: number[] } | null = null;
    if (turnParam === "orphan") opts = { orphans: true };
    else if (Number.isInteger(Number(turnParam))) opts = { turnSeqs: [Number(turnParam)] };
    if (!opts) return sendJson(res, 400, { error: "bad_request", message: 'turnSeq must be an integer or "orphan"' });
    const requests = (await deps.sessions?.listLlmRequests(id, opts)) ?? [];
    return sendJson(res, 200, { session, requests });
  }
  const requests = (await deps.sessions?.listLlmRequests(id, { omitRequest: true })) ?? [];
  return sendJson(res, 200, { session, requests });
}

export async function getAdminSession(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, params, url } = ctx;
  const id = params.id!;
  const scoped = await requireAdminSession(ctx, id);
  if (!scoped) return;
  const { actor, scope, record: session } = scoped;
  audit(ctx, { principalId: actor.id, action: "session.read", resource: id, scopeLabel: session.scopeId });
  const want = Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || TRANSCRIPT_LIMIT_DEFAULT);
  const all = want >= TRANSCRIPT_LIMIT_MAX;
  const limit = Math.min(want, TRANSCRIPT_LIMIT_MAX);
  const raw = deps.sessions
    ? (await createTranscriptSource(deps.sessions).forRender(id, all ? undefined : { limit: limit + 1 })).items
    : [];
  const hasMore = !all && raw.length > limit;
  const items = await labelTranscriptItems(app, deps, session, hasMore ? raw.slice(raw.length - limit) : raw);
  const recipientDeliveries = deps.deliveries
    ? await deps.deliveries.listByRecipientThread(session.threadRef, { limit: 100 })
    : [];
  const sourceDeliveries = deps.deliveries
    ? await deps.deliveries.listBySourceSession(session.id, session.threadRef, { limit: 100 })
    : [];
  const cronLookup = await cronOrigins(app, [
    session.threadRef,
    ...[...recipientDeliveries, ...sourceDeliveries].map((d) => d.provenance?.fireKey ?? d.idempotencyKey),
  ]);
  const sidecars = await deliveryProvenanceSidecars(deps, recipientDeliveries, scope);
  const recipientDeliveryEvents = await Promise.all(
    recipientDeliveries.map(async (d) => {
      const provenance = sidecars.get(d.id) ?? null;
      return {
        type: "principal_delivery",
        deliveryId: d.id,
        text: d.text,
        attachments: d.attachments ?? [],
        destination: d.destination,
        createdAt: d.deliveredAt ?? d.createdAt,
        idempotencyKey: d.idempotencyKey,
        provenance: d.provenance ?? null,
        origin: await deliveryOrigin(app, d, scope, cronLookup),
        ...(provenance?.sourceSession ? { sourceSession: provenance.sourceSession } : {}),
        ...(provenance?.llmRequests ? { llmRequests: provenance.llmRequests } : {}),
      };
    }),
  );
  const sourceDeliveryEvents = await Promise.all(
    sourceDeliveries.map(async (d) => ({
      type: "outbound_delivery",
      deliveryId: d.id,
      text: d.text,
      attachments: d.attachments ?? [],
      destination: d.destination,
      createdAt: d.deliveredAt ?? d.createdAt,
      idempotencyKey: d.idempotencyKey,
      provenance: d.provenance ?? null,
      origin: await deliveryOrigin(app, d, scope, cronLookup),
      ...(d.recipientThreadRef ? { recipientThreadRef: d.recipientThreadRef } : {}),
      ...(d.deliveredAt !== null ? { deliveredAt: d.deliveredAt } : {}),
      ...(d.expiredAt !== undefined ? { expiredAt: d.expiredAt } : {}),
      ...(d.shadow ? { shadow: true } : {}),
    })),
  );
  const deliveryEvents = [...recipientDeliveryEvents, ...sourceDeliveryEvents];
  return sendJson(res, 200, {
    session,
    items,
    deliveryEvents,
    hasMore,
    limit,
    origin: await sessionOrigin(app, session, scope, cronLookup),
  });
}

export async function listAdminShadowDeliveries(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(ctx, {
    principalId: actor.id,
    action: "deliveries.shadow.read",
    resource: "deliveries/shadow",
    scopeLabel: scope,
  });
  const orgWide = parseScopeId(scope).kind === "org";
  const rows = (await deps.deliveries?.listShadow({ limit: 200 })) ?? [];
  const cronLookup = await cronOrigins(
    app,
    rows.map((d) => d.provenance?.fireKey ?? d.idempotencyKey),
  );
  const shadow = await Promise.all(
    rows
      .filter((d) => orgWide || d.provenance?.sourceScopeId === scope)
      .map(async (d) => ({
        deliveryId: d.id,
        text: d.text,
        destination: d.destination,
        createdAt: d.createdAt,
        idempotencyKey: d.idempotencyKey,
        provenance: d.provenance ?? null,
        shadow: true as const,
        origin: await deliveryOrigin(app, d, scope, cronLookup),
      })),
  );
  return sendJson(res, 200, { scopeId: scope, shadow });
}
