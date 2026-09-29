import { api, ApiError, type CoreSession } from "./core-bridge.ts";
import { subagentState } from "../../chassis/src/session-navigation.ts";
import type {
  SessionNavigationRequest,
  SessionNavigationResult,
  SessionPageRequest,
  SessionPageResult,
  SessionReference,
  SessionResolveResult,
} from "../../chassis/src/session-navigation.ts";

const UNSUPPORTED = Symbol("unsupported session navigation");
let legacy = false;
export function resetNavigationTransport(): void {
  legacy = false;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid session navigation response");
  return value as Record<string, unknown>;
}
function requireValue(valid: boolean): void {
  if (!valid) throw new Error("Invalid session navigation response");
}
function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
function count(value: unknown): boolean {
  return finite(value) && Number.isSafeInteger(value) && (value as number) >= 0;
}
function string(value: unknown): boolean {
  return typeof value === "string";
}
function session(value: unknown): void {
  const row = object(value);
  requireValue(
    string(row.id) &&
      Boolean(row.id) &&
      string(row.scopeId) &&
      string(row.threadRef) &&
      finite(row.createdAt) &&
      ["dm", "channel", "group"].includes(String(row.type)),
  );
  for (const field of ["title", "channelName", "color"]) requireValue(row[field] == null || string(row[field]));
  for (const field of ["archived", "pinned", "working", "awaitingInput", "lastTurnFailed", "hasEntries"])
    requireValue(row[field] === undefined || typeof row[field] === "boolean");
  for (const field of ["lastActivityAt"]) requireValue(row[field] === undefined || finite(row[field]));
  for (const field of ["parentSessionId", "surface"]) requireValue(row[field] === undefined || string(row[field]));
  for (const field of ["backgroundJobs", "watches", "crons"])
    requireValue(row[field] === undefined || count(row[field]));
  if (row.subagents !== undefined) {
    const subagents = object(row.subagents);
    requireValue(count(subagents.running) && count(subagents.waiting));
  }
}
function page(value: unknown, check: (value: unknown) => void): void {
  const result = object(value);
  requireValue(
    Array.isArray(result.items) &&
      result.items.length <= 50 &&
      count(result.total) &&
      (result.total as number) >= (result.items as unknown[]).length &&
      (result.nextCursor === null ||
        (string(result.nextCursor) &&
          (result.nextCursor as string).length > 0 &&
          (result.nextCursor as string).length <= 4096)),
  );
  requireValue(result.nextCursor === null || (result.items as unknown[]).length === 50);
  (result.items as unknown[]).forEach(check);
  const ids = (result.items as Record<string, unknown>[]).map((item) => item.id ?? item.scopeId);
  requireValue(new Set(ids).size === ids.length);
}
function contexts(value: unknown, max: number): void {
  requireValue(Array.isArray(value) && value.length <= max);
  for (const item of value as unknown[]) {
    const context = object(item);
    requireValue(
      string(context.scopeId) &&
        ["personal", "channel", "group"].includes(String(context.kind)) &&
        (context.name === null || string(context.name)) &&
        count(context.sessionCount) &&
        (context.lastActivityAt === null || finite(context.lastActivityAt)),
    );
    requireValue(context.isPrivate === undefined || typeof context.isPrivate === "boolean");
    if (context.project !== undefined) {
      const project = object(context.project);
      requireValue(
        string(project.id) &&
          string(project.name) &&
          string(project.ownerId) &&
          finite(project.createdAt) &&
          finite(project.updatedAt),
      );
      requireValue(project.members === undefined && project.memberIds === undefined);
    }
  }
}
function totals(value: unknown): void {
  const result = object(value);
  requireValue(count(result.active) && count(result.waiting) && count(result.archived));
}
function references(value: unknown, requested: SessionReference[]): void {
  requireValue(Array.isArray(value) && value.length === requested.length && value.length <= 12);
  (value as unknown[]).forEach((item, i) => {
    const row = object(item);
    const reference = object(row.reference);
    requireValue(reference.kind === requested[i]!.kind && reference.value === requested[i]!.value);
    if (row.session !== null) {
      session(row.session);
      const resolved = row.session as CoreSession;
      requireValue(reference.kind === "id" ? resolved.id === reference.value : resolved.threadRef === reference.value);
    }
  });
}
function unsupported(error: unknown, path: string): boolean {
  if (!(error instanceof ApiError) || error.status !== 404 || !error.body || typeof error.body !== "object")
    return false;
  const body = error.body as Record<string, unknown>;
  return (
    (Object.keys(body).length === 1 && body.error === "not found") ||
    (Object.keys(body).length === 2 &&
      body.error === "not_found" &&
      body.message === `POST ${path.replace(/^\/api\//, "/v1/")}`)
  );
}
async function read(path: string, body: object, signal?: AbortSignal): Promise<unknown | null> {
  signal?.throwIfAborted();
  if (legacy) return UNSUPPORTED;
  try {
    const result = await api(path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted || !unsupported(error, path)) throw error;
    legacy = true;
    return UNSUPPORTED;
  }
}
export async function fetchNavigation(
  request: SessionNavigationRequest,
  signal?: AbortSignal,
): Promise<SessionNavigationResult<CoreSession> | null> {
  const value = await read("/api/session-navigation", request, signal);
  if (value === UNSUPPORTED) return null;
  const result = object(value);
  page(result.recent, session);
  page(result.pinned, session);
  page(result.groups, (value) => {
    const group = object(value);
    requireValue(
      string(group.scopeId) &&
        (group.name === null || string(group.name)) &&
        ["personal", "project", "channel", "group"].includes(String(group.kind)) &&
        count(group.count) &&
        finite(group.lastActivityAt) &&
        group.sessions === undefined &&
        group.members === undefined,
    );
  });
  if (request.section === "archived") page(result.archived, session);
  else requireValue(result.archived === undefined);
  requireValue(count(result.archivedCount));
  contexts(result.contexts, result.archived ? 213 : 163);
  totals(result.statusTotals);
  references(result.references, request.references ?? []);
  const startup = object(result.startup);
  requireValue(
    typeof startup.hasSessions === "boolean" &&
      typeof startup.hasNonCronSessions === "boolean" &&
      (startup.oldestPersonalThreadRef === null || string(startup.oldestPersonalThreadRef)),
  );
  if (startup.latest !== null) session(startup.latest);
  return value as SessionNavigationResult<CoreSession>;
}
export async function fetchSessionPage(
  request: SessionPageRequest,
  signal?: AbortSignal,
): Promise<SessionPageResult<CoreSession> | null> {
  const value = await read("/api/session-navigation/page", request, signal);
  if (value === UNSUPPORTED) return null;
  const result = object(value);
  page(result, session);
  contexts(result.contexts, 51);
  totals(result.statusTotals);
  if (request.actionable) {
    const metadata = object(result.actionable);
    const items = result.items as CoreSession[];
    requireValue(
      metadata.parentSessionId === request.parentSessionId &&
        Array.isArray(metadata.depths) &&
        metadata.depths.length === items.length &&
        metadata.depths.every((depth) => count(depth) && (depth as number) > 0) &&
        items.every((row) => subagentState(row) !== "done"),
    );
    if (metadata.parentSubagents === null)
      requireValue(items.length === 0 && result.total === 0 && result.nextCursor === null);
    else {
      const summary = object(metadata.parentSubagents);
      requireValue(count(summary.running) && count(summary.waiting));
    }
  } else requireValue(result.actionable === undefined);
  return value as SessionPageResult<CoreSession>;
}
export async function fetchSessionReferences(
  requested: SessionReference[],
  signal?: AbortSignal,
): Promise<SessionResolveResult<CoreSession> | null> {
  if (requested.length > 12) throw new Error("Too many session references");
  const value = await read("/api/session-navigation/resolve", { references: requested }, signal);
  if (value === UNSUPPORTED) return null;
  references(object(value).references, requested);
  return value as SessionResolveResult<CoreSession>;
}
