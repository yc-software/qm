import {
  activityOf,
  descendantsOf,
  subagentCounts,
  subagentState,
  chatBrowseStatusMatches,
  chatMatches,
  recentProjectSeeds,
  surfaceOf,
  type SessionNavigationContext,
  type SessionNavigationGroup,
  type SessionNavigationPage,
  type SessionNavigationRequest,
  type SessionNavigationResult,
  type SessionPageRequest,
  type SessionPageResult,
  type SessionReference,
  type SessionResolveResult,
  type SessionStatusTotals,
} from "../../plugins/chassis/src/session-navigation.ts";
import type { Session } from "../types.ts";
import type { ContextSummary } from "./app-types.ts";

const SESSION_NAVIGATION_LIMIT = 50;
export const SESSION_REFERENCE_LIMIT = 12;

export class InvalidSessionNavigationRequest extends Error {}

type Cursor = { key: string; at: number; id: string };

function cursorFor(raw: string | undefined, key: string): Cursor | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Object.keys(parsed).sort().join() !== "at,id,key" ||
      parsed.key !== key ||
      typeof parsed.at !== "number" ||
      !Number.isFinite(parsed.at) ||
      typeof parsed.id !== "string" ||
      !parsed.id ||
      parsed.id.length > 512
    )
      throw new Error();
    return parsed;
  } catch {
    throw new InvalidSessionNavigationRequest("invalid session cursor");
  }
}

function page<T>(
  items: T[],
  key: string,
  raw: string | undefined,
  identity: (item: T) => { at: number; id: string },
): SessionNavigationPage<T> {
  const cursor = cursorFor(raw, key);
  const sorted = [...items].sort((a, b) => {
    const x = identity(a);
    const y = identity(b);
    return y.at - x.at || (x.id < y.id ? -1 : Number(x.id !== y.id));
  });
  const remaining = cursor
    ? sorted.filter((item) => {
        const value = identity(item);
        return value.at < cursor.at || (value.at === cursor.at && value.id > cursor.id);
      })
    : sorted;
  const selected = remaining.slice(0, SESSION_NAVIGATION_LIMIT);
  return {
    items: selected,
    total: items.length,
    nextCursor:
      remaining.length > selected.length
        ? Buffer.from(JSON.stringify({ key, ...identity(selected.at(-1)!) })).toString("base64url")
        : null,
  };
}

const withSubagents = (session: Session, all: Session[]): Session => ({
  ...session,
  subagents: subagentCounts(all, session.id),
});

const sessionIdentity = (session: Session) => ({ at: activityOf(session), id: session.id });
const navigationKey = (request: SessionNavigationRequest, section: string) =>
  JSON.stringify([section, request.surface ?? "all"]);
const pageKey = (request: SessionPageRequest) =>
  JSON.stringify([
    request.surface ?? "all",
    request.status ?? null,
    request.scopeId ?? null,
    (request.query ?? "").trim().toLowerCase(),
    request.title ?? null,
    request.children ?? false,
    request.parentSessionId ?? null,
    request.pinned ?? null,
    request.archived ?? null,
    ...(request.actionable ? ["actionable"] : []),
  ]);

export function validateNavigationCursor(request: SessionNavigationRequest): void {
  if (request.cursor && !request.section) throw new InvalidSessionNavigationRequest("section required with cursor");
  cursorFor(request.cursor, navigationKey(request, request.section ?? "recent"));
}

export function validateSessionPageCursor(request: SessionPageRequest): void {
  if (request.parentSessionId !== undefined && request.children !== true)
    throw new InvalidSessionNavigationRequest("children required with parentSessionId");
  if (request.actionable && !request.parentSessionId)
    throw new InvalidSessionNavigationRequest("parentSessionId required with actionable");
  cursorFor(request.cursor, pageKey(request));
}

function compactContext(context: ContextSummary): SessionNavigationContext {
  const { project, ...rest } = context;
  return {
    ...rest,
    ...(project
      ? {
          project: {
            id: project.id,
            name: project.name,
            ownerId: project.ownerId,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
        }
      : {}),
  };
}

function selectedContexts(contexts: ContextSummary[], scopes: Iterable<string>): SessionNavigationContext[] {
  const selected = new Set(scopes);
  return contexts.filter((context) => selected.has(context.scopeId)).map(compactContext);
}

function statusTotals(sessions: Session[]): SessionStatusTotals {
  const roots = sessions.filter((session) => !session.parentSessionId);
  return {
    active: roots.filter((session) => chatBrowseStatusMatches(session, "active")).length,
    waiting: roots.filter((session) => chatBrowseStatusMatches(session, "waiting")).length,
    archived: roots.filter((session) => chatBrowseStatusMatches(session, "archived")).length,
  };
}

export function resolveSessionReferences(
  sessions: Session[],
  references: SessionReference[],
): SessionResolveResult<Session> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const byThread = new Map(sessions.map((session) => [session.threadRef, session]));
  return {
    references: references.map((reference) => ({
      reference,
      session: (reference.kind === "id" ? byId : byThread).get(reference.value) ?? null,
    })),
  };
}

export function projectSessionPage(
  sessions: Session[],
  contexts: ContextSummary[],
  request: SessionPageRequest,
  authorized: readonly Session[] = sessions,
): SessionPageResult<Session> {
  validateSessionPageCursor(request);
  const descendants = request.parentSessionId
    ? new Map(
        authorized.some((session) => session.id === request.parentSessionId)
          ? descendantsOf(sessions, request.parentSessionId).map(({ session, depth }) => [session.id, depth])
          : [],
      )
    : null;
  const projects = new Map(contexts.map((context) => [context.scopeId, context.project?.name ?? null]));
  const query = (request.query ?? "").trim().toLowerCase();
  const matching = sessions.filter(
    (session) =>
      (!descendants || descendants.has(session.id)) &&
      (!request.actionable || subagentState(session) !== "done") &&
      (request.children || !session.parentSessionId) &&
      (request.title === undefined || session.title === request.title) &&
      (!request.scopeId || request.scopeId === session.scopeId) &&
      (!request.surface || request.surface === "all" || surfaceOf(session) === request.surface) &&
      (!request.status || chatBrowseStatusMatches(session, request.status)) &&
      (request.pinned === undefined || Boolean(session.pinned) === request.pinned) &&
      (request.archived === undefined || Boolean(session.archived) === request.archived) &&
      (!query || chatMatches(session, query, projects.get(session.scopeId) ?? null)),
  );
  const result = page(matching, pageKey(request), request.cursor, sessionIdentity);
  return {
    ...result,
    items: result.items.map((session) => withSubagents(session, sessions)),
    contexts: selectedContexts(contexts, [
      ...result.items.map((session) => session.scopeId),
      ...(request.scopeId ? [request.scopeId] : []),
    ]),
    statusTotals: statusTotals(sessions),
    ...(request.actionable
      ? {
          actionable: {
            parentSessionId: request.parentSessionId!,
            parentSubagents: authorized.some((session) => session.id === request.parentSessionId)
              ? subagentCounts(sessions, request.parentSessionId)
              : null,
            depths: result.items.map((session) => descendants!.get(session.id)!),
          },
        }
      : {}),
  };
}

export function projectSessionNavigation(
  sessions: Session[],
  raw: Session[],
  contexts: ContextSummary[],
  principalId: string,
  request: SessionNavigationRequest,
): SessionNavigationResult<Session> {
  const roots = sessions.filter(
    (session) => !session.parentSessionId && (request.surface !== "web" || surfaceOf(session) === "web"),
  );
  const active = roots.filter((session) => !session.archived);
  const recent = page(
    active.filter((session) => !session.pinned),
    navigationKey(request, "recent"),
    request.section === "recent" ? request.cursor : undefined,
    sessionIdentity,
  );
  const pinned = page(
    active.filter((session) => session.pinned),
    navigationKey(request, "pinned"),
    request.section === "pinned" ? request.cursor : undefined,
    sessionIdentity,
  );
  const archivedRows = roots.filter((session) => session.archived);
  const archived =
    request.section === "archived"
      ? page(archivedRows, navigationKey(request, "archived"), request.cursor, sessionIdentity)
      : undefined;
  const counts = new Map<string, { count: number; at: number }>();
  for (const session of active) {
    if (session.pinned) continue;
    const previous = counts.get(session.scopeId);
    counts.set(session.scopeId, {
      count: (previous?.count ?? 0) + 1,
      at: Math.max(previous?.at ?? 0, activityOf(session)),
    });
  }
  const contextByScope = new Map(contexts.map((context) => [context.scopeId as string, context]));
  const groupRows: SessionNavigationGroup[] = recentProjectSeeds(contexts).flatMap((seed) => {
    const counted = counts.get(seed.scopeId);
    if (!counted && (seed.kind === "channel" || seed.kind === "group")) return [];
    const context = contextByScope.get(seed.scopeId)!;
    return [
      {
        scopeId: seed.scopeId,
        name: seed.name,
        kind: seed.kind ?? "project",
        count: counted?.count ?? 0,
        lastActivityAt:
          counted?.at ?? context.lastActivityAt ?? context.project?.createdAt ?? context.project?.updatedAt ?? 0,
      },
    ];
  });
  const groups = page(
    groupRows,
    navigationKey(request, "groups"),
    request.section === "groups" ? request.cursor : undefined,
    (group) => ({ at: group.lastActivityAt, id: group.scopeId }),
  );
  const decoratedById = new Map(sessions.map((session) => [session.id, session]));
  const resolved = resolveSessionReferences(
    raw.map((session) => decoratedById.get(session.id) ?? session),
    request.references ?? [],
  );
  const personal = sessions.filter(
    (session) =>
      session.scopeId === `personal:${principalId}` &&
      session.threadRef.startsWith(`web:${principalId}:`) &&
      !session.threadRef.startsWith(`web:${principalId}:ideas:`),
  );
  personal.sort(
    (a, b) => a.createdAt - b.createdAt || (a.threadRef < b.threadRef ? -1 : Number(a.threadRef !== b.threadRef)),
  );
  const latest = page(sessions, "latest", undefined, sessionIdentity).items[0] ?? null;
  const selected = [
    ...recent.items,
    ...pinned.items,
    ...(archived?.items ?? []),
    ...resolved.references.flatMap((ref) => (ref.session ? [ref.session] : [])),
    ...(latest ? [latest] : []),
  ];
  return {
    recent: { ...recent, items: recent.items.map((session) => withSubagents(session, sessions)) },
    pinned: { ...pinned, items: pinned.items.map((session) => withSubagents(session, sessions)) },
    groups,
    ...(archived
      ? { archived: { ...archived, items: archived.items.map((session) => withSubagents(session, sessions)) } }
      : {}),
    archivedCount: archivedRows.length,
    contexts: selectedContexts(contexts, [
      ...selected.map((session) => session.scopeId),
      ...groups.items.map((group) => group.scopeId),
    ]),
    statusTotals: statusTotals(sessions),
    references: resolved.references.map((row) => ({
      ...row,
      session: row.session ? withSubagents(row.session, sessions) : null,
    })),
    startup: {
      hasSessions: sessions.some((session) => session.id),
      hasNonCronSessions: sessions.some((session) => session.id && !session.threadRef.startsWith("cron:")),
      oldestPersonalThreadRef: personal[0]?.threadRef ?? null,
      latest: latest ? withSubagents(latest, sessions) : null,
    },
  };
}
