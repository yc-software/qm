import type { App } from "../../app.ts";
import type { ServerDeps } from "../../deps.ts";
import {
  parseScopeId,
  type Delivery,
  type DeliveryProvenance,
  type Session,
  type SessionEntry,
} from "../../../types.ts";
import { transcriptEntries, type LlmRequestRecord } from "../../../sessions/session-store.ts";
import { swallowAs } from "../../../util/errors.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";
import { requireScopedResource } from "./common.ts";
import {
  cronWakeOrigin,
  deliveryOrigin,
  parseSessionWakeRef,
  sessionCategory,
  sessionKind,
  sessionOrigin,
  type AdminSessionCategory,
  type AdminSessionOrigin,
} from "./origins.ts";

const SESSIONS_PAGE_LIMIT_MAX = 200;
const SESSIONS_PAGE_LIMIT_DEFAULT = 50;
const TRANSCRIPT_LIMIT_MAX = 50000;
const TRANSCRIPT_LIMIT_DEFAULT = 500;

async function displayNameForPrincipal(app: App, deps: ServerDeps, principalId: string): Promise<string> {
  return (await app.directoryMember(principalId))?.displayName?.trim() || principalId;
}

async function inferSingleParticipantName(app: App, deps: ServerDeps, sessionId: string): Promise<string | null> {
  const participantIds = new Set((await deps.sessions?.participantsOf(sessionId)) ?? []);
  if (participantIds.size !== 1) return null;
  return displayNameForPrincipal(app, deps, [...participantIds][0]!);
}

function withEntryName(entry: SessionEntry, name: string): SessionEntry {
  if (entry.type !== "user" || !name.trim() || typeof entry.payload !== "object" || entry.payload === null)
    return entry;
  const payload = entry.payload as Record<string, unknown>;
  if (typeof payload.name === "string" && payload.name.trim()) return entry;
  return { ...entry, payload: { ...payload, name } };
}

async function labelTranscriptEntries(
  app: App,
  deps: ServerDeps,
  session: Session,
  entries: SessionEntry[],
): Promise<SessionEntry[]> {
  const fallbackName = await inferSingleParticipantName(app, deps, session.id);
  if (!fallbackName) return entries;
  return entries.map((entry) => withEntryName(entry, fallbackName));
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
  await Promise.all(
    [...bySource.values()].map(async (group) => {
      const provenance = group[0]!.provenance!;
      const sourceSession = provenance.sourceSessionId
        ? await deps.sessions?.get(provenance.sourceSessionId)
        : await deps.sessions?.getByThread(provenance.sourceThreadRef);
      if (!sourceSession || (!orgWide && sourceSession.scopeId !== requestedScope)) {
        for (const d of group) out.set(d.id, { provenance: d.provenance! });
        return;
      }
      const seqBounds = group.map((d) => d.provenance!.sourceUserSeq).filter((s): s is number => s !== undefined);
      const sourceEntries = seqBounds.length
        ? ((await deps.sessions?.getEntries(sourceSession.id, { sinceSeq: Math.min(...seqBounds) })) ?? [])
        : [];
      const turnSeqsFor = (p: DeliveryProvenance): Set<number> => {
        const seqs = new Set<number>();
        if (p.sourceUserSeq === undefined) return seqs;
        for (const e of sourceEntries) {
          if (e.seq < p.sourceUserSeq) continue;
          if (p.sourceAssistantEntrySeq !== undefined && e.seq > p.sourceAssistantEntrySeq) continue;
          if (e.type === "user") seqs.add(e.seq);
        }
        seqs.add(p.sourceUserSeq);
        return seqs;
      };
      const perDelivery = group.map((d) => ({ d, turnSeqs: turnSeqsFor(d.provenance!) }));
      const allTurnSeqs = new Set(perDelivery.flatMap(({ turnSeqs }) => [...turnSeqs]));
      const requests = allTurnSeqs.size
        ? ((await deps.sessions?.listLlmRequests(sourceSession.id, { turnSeqs: [...allTurnSeqs] })) ?? [])
        : [];
      for (const { d, turnSeqs } of perDelivery) {
        const own = requests.filter((r) => r.turnSeq !== null && turnSeqs.has(r.turnSeq));
        out.set(d.id, {
          provenance: d.provenance!,
          sourceSession,
          ...(own.length ? { llmRequests: own } : {}),
        });
      }
    }),
  );
  return out;
}

export async function listAdminSessions(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "sessions.read", resource: "sessions", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const categoryParam = url.searchParams.get("category") ?? "conversation";
  let category: AdminSessionCategory | "all" = "conversation";
  if (categoryParam === "background" || categoryParam === "all") category = categoryParam;
  const categoryFilter = category === "all" ? undefined : category;
  const originParam = url.searchParams.get("origin");
  const originFilter: AdminSessionOrigin | undefined =
    originParam === "cron" || originParam === "other_background" ? originParam : undefined;
  const cronId = url.searchParams.get("cron") || undefined;
  const stats = (await deps.sessions?.scopeSessionStats(scope, orgWide, categoryFilter, originFilter, cronId)) ?? {
    total: 0,
    turns: 0,
    byType: {},
    byTypeAll: {},
    totalByCategory: { conversation: 0, background: 0, all: 0 },
    crons: 0,
  };
  const limit = Math.min(
    SESSIONS_PAGE_LIMIT_MAX,
    Math.max(1, Number(url.searchParams.get("limit")) || SESSIONS_PAGE_LIMIT_DEFAULT),
  );
  if (originFilter === "cron" && !cronId) {
    const groups = (await deps.sessions?.scopeCronGroups(scope, orgWide)) ?? [];
    const deliveredByCron =
      deps.deliveries && groups.length
        ? await deps.deliveries
            .sentRunCountsByCron(groups.map((g) => g.cronId))
            .catch(swallowAs("api: admin cron delivered counts failed", null))
        : null;
    const cronLookup = groups.length ? new Map((await app.listCrons()).map((c) => [c.id, c])) : undefined;
    const crons = await Promise.all(
      groups.map(async (g) => ({
        ...g,
        ...(deliveredByCron ? { deliveredRuns: deliveredByCron.get(g.cronId) ?? 0 } : {}),
        origin: await cronWakeOrigin(
          app,
          {
            trigger: "cron",
            sourceId: g.cronId,
            fireKey: `agent:main:cron:${g.cronId}`,
            fireSlot: null,
            monologue: true,
          },
          scope,
          g.scopeId,
          cronLookup,
        ),
      })),
    );
    return sendJson(res, 200, {
      scopeId: scope,
      crons,
      total: groups.length,
      totalByCategory: stats.totalByCategory,
      totalByType: stats.byTypeAll,
      distinctCrons: stats.crons,
      category,
      turns: stats.turns,
      byType: stats.byType,
      limit,
      offset: 0,
    });
  }
  const total = stats.total;
  const lastOffset = total ? Math.floor((total - 1) / limit) * limit : 0;
  const cursorParam = url.searchParams.get("cursor");
  const cursorMatch = cursorParam ? /^(\d+)~(.+)$/.exec(cursorParam) : null;
  const before = cursorMatch ? { lastActivity: Number(cursorMatch[1]), id: cursorMatch[2]! } : undefined;
  const offset = before ? 0 : Math.min(Math.max(0, Number(url.searchParams.get("offset")) || 0), lastOffset);
  const summaries =
    (await deps.sessions?.scopeSessionSummaries(scope, orgWide, {
      limit,
      offset,
      ...(before ? { before } : {}),
      ...(categoryFilter ? { category: categoryFilter } : {}),
      ...(originFilter ? { origin: originFilter } : {}),
      ...(cronId ? { cronId } : {}),
    })) ?? [];
  const categories = new Map(summaries.map((s) => [s.id, sessionCategory(s)]));
  const background = summaries.filter((s) => categories.get(s.id) === "background");
  const sentCounts =
    deps.deliveries && background.length
      ? await deps.deliveries
          .sentCountsBySourceSessions(background.map((s) => ({ sessionId: s.id, threadRef: s.threadRef })))
          .catch(swallowAs("api: admin sessions sent counts failed", null))
      : null;
  const needCrons = !!cronId || summaries.some((s) => parseSessionWakeRef(s.threadRef)?.trigger === "cron");
  const cronLookup = needCrons ? new Map((await app.listCrons()).map((c) => [c.id, c])) : undefined;
  const sessions = await Promise.all(
    summaries.map(async (s) => ({
      ...s,
      category: categories.get(s.id)!,
      kind: sessionKind(s),
      origin: await sessionOrigin(app, s, scope, cronLookup),
      ...(sentCounts && categories.get(s.id) === "background" ? { delivered: sentCounts.get(s.id) ?? 0 } : {}),
    })),
  );
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
    total,
    totalByCategory: stats.totalByCategory,
    totalByType: stats.byTypeAll,
    distinctCrons: stats.crons,
    category,
    turns: stats.turns,
    byType: stats.byType,
    limit,
    offset,
    ...(summaries.length === limit
      ? { nextCursor: `${summaries[summaries.length - 1]!.lastActivity}~${summaries[summaries.length - 1]!.id}` }
      : {}),
  });
}

export async function getAdminSessionLlm(ctx: ApiCtx): Promise<void> {
  const { res, deps, params, url } = ctx;
  const id = params.id!;
  const scoped = await requireScopedResource(
    ctx,
    () => deps.sessions?.get(id),
    (s) => s.scopeId,
    "session",
  );
  if (!scoped) return;
  const { actor, record: session } = scoped;
  audit(deps, { principalId: actor.id, action: "session.llm.read", resource: id, scopeLabel: session.scopeId });
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
  const scoped = await requireScopedResource(
    ctx,
    () => deps.sessions?.get(id),
    (s) => s.scopeId,
    "session",
  );
  if (!scoped) return;
  const { actor, scope, record: session } = scoped;
  audit(deps, { principalId: actor.id, action: "session.read", resource: id, scopeLabel: session.scopeId });
  const want = Math.max(1, Number(url.searchParams.get("limit")) || TRANSCRIPT_LIMIT_DEFAULT);
  const all = want >= TRANSCRIPT_LIMIT_MAX;
  const limit = Math.min(want, TRANSCRIPT_LIMIT_MAX);
  const raw = (await deps.sessions?.getEntries(id, all ? undefined : { limit: limit + 1 })) ?? [];
  const hasMore = !all && raw.length > limit;
  const entries = await labelTranscriptEntries(
    app,
    deps,
    session,
    transcriptEntries(hasMore ? raw.slice(raw.length - limit) : raw),
  );
  const recipientDeliveries = deps.deliveries
    ? await deps.deliveries.listByRecipientThread(session.threadRef, { limit: 100 })
    : [];
  const sourceDeliveries = deps.deliveries
    ? await deps.deliveries.listBySourceSession(session.id, session.threadRef, { limit: 100 })
    : [];
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
        origin: await deliveryOrigin(app, d, scope),
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
      origin: await deliveryOrigin(app, d, scope),
      ...(d.recipientThreadRef ? { recipientThreadRef: d.recipientThreadRef } : {}),
      ...(d.deliveredAt !== null ? { deliveredAt: d.deliveredAt } : {}),
      ...(d.shadow ? { shadow: true } : {}),
    })),
  );
  const deliveryEvents = [...recipientDeliveryEvents, ...sourceDeliveryEvents];
  return sendJson(res, 200, {
    session,
    entries,
    deliveryEvents,
    hasMore,
    limit,
    origin: await sessionOrigin(app, session, scope),
  });
}

export async function listAdminShadowDeliveries(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, {
    principalId: actor.id,
    action: "deliveries.shadow.read",
    resource: "deliveries/shadow",
    scopeLabel: scope,
  });
  const orgWide = parseScopeId(scope).kind === "org";
  const rows = (await deps.deliveries?.listShadow({ limit: 200 })) ?? [];
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
        origin: await deliveryOrigin(app, d, scope),
      })),
  );
  return sendJson(res, 200, { scopeId: scope, shadow });
}
