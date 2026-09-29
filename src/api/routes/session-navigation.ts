import {
  type SessionNavigationRequest,
  type SessionPageRequest,
  type SessionReference,
} from "../../../plugins/chassis/src/session-navigation.ts";
import {
  InvalidSessionNavigationRequest,
  SESSION_REFERENCE_LIMIT,
  validateNavigationCursor,
  validateSessionPageCursor,
} from "../session-navigation.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new InvalidSessionNavigationRequest("object required");
  return value as Record<string, unknown>;
}

function keys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new InvalidSessionNavigationRequest("unknown navigation field");
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new InvalidSessionNavigationRequest(`invalid ${name}`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new InvalidSessionNavigationRequest(`invalid ${name}`);
  return value as T;
}

function references(value: unknown): SessionReference[] {
  if (!Array.isArray(value) || value.length > SESSION_REFERENCE_LIMIT)
    throw new InvalidSessionNavigationRequest("invalid session references");
  return value.map((value) => {
    const ref = object(value);
    keys(ref, ["kind", "value"]);
    const kind = oneOf(ref.kind, ["id", "thread"], "reference kind");
    if (!kind) throw new InvalidSessionNavigationRequest("reference kind required");
    return { kind, value: text(ref.value, "reference", kind === "id" ? 512 : 2048) };
  });
}

async function handle(ctx: ApiCtx, operation: "navigation" | "page" | "resolve"): Promise<void> {
  if (ctx.res.destroyed || ctx.res.writableEnded) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  ctx.res.once("close", abort);
  try {
    const body = object(ctx.body);
    const principal = text(body.principalId, "principalId", 512);
    let result: unknown;
    if (operation === "resolve") {
      keys(body, ["principalId", "references"]);
      result = await ctx.app.resolveSessions(principal, references(body.references), controller.signal);
    } else if (operation === "navigation") {
      keys(body, ["principalId", "surface", "section", "cursor", "references"]);
      const request: SessionNavigationRequest = {
        surface: oneOf(body.surface, ["all", "web"], "surface"),
        section: oneOf(body.section, ["recent", "pinned", "groups", "archived"], "section"),
        ...(body.cursor === undefined ? {} : { cursor: text(body.cursor, "cursor", 4096) }),
        ...(body.references === undefined ? {} : { references: references(body.references) }),
      };
      validateNavigationCursor(request);
      result = await ctx.app.sessionNavigation(principal, request, controller.signal);
    } else {
      keys(body, [
        "principalId",
        "surface",
        "status",
        "scopeId",
        "query",
        "title",
        "children",
        "parentSessionId",
        "actionable",
        "pinned",
        "archived",
        "cursor",
      ]);
      for (const field of ["children", "actionable", "pinned", "archived"]) {
        if (body[field] !== undefined && typeof body[field] !== "boolean")
          throw new InvalidSessionNavigationRequest(`invalid ${field}`);
      }
      if (body.query !== undefined && (typeof body.query !== "string" || body.query.length > 512))
        throw new InvalidSessionNavigationRequest("invalid query");
      const request: SessionPageRequest = {
        surface: oneOf(body.surface, ["all", "web", "slack", "core"], "surface"),
        status: oneOf(body.status, ["active", "waiting", "archived"], "status"),
        ...(body.scopeId === undefined ? {} : { scopeId: text(body.scopeId, "scopeId", 512) }),
        ...(body.cursor === undefined ? {} : { cursor: text(body.cursor, "cursor", 4096) }),
        ...(body.query === undefined ? {} : { query: body.query as string }),
        ...(body.title === undefined ? {} : { title: text(body.title, "title", 512) }),
        ...(body.children === undefined ? {} : { children: body.children as boolean }),
        ...(body.actionable === undefined ? {} : { actionable: body.actionable as boolean }),
        ...(body.parentSessionId === undefined
          ? {}
          : { parentSessionId: text(body.parentSessionId, "parentSessionId", 512) }),
        ...(body.pinned === undefined ? {} : { pinned: body.pinned as boolean }),
        ...(body.archived === undefined ? {} : { archived: body.archived as boolean }),
      };
      validateSessionPageCursor(request);
      result = await ctx.app.sessionPage(principal, request, controller.signal);
    }
    if (!controller.signal.aborted) sendJson(ctx.res, 200, result);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof InvalidSessionNavigationRequest)
      sendJson(ctx.res, 400, { error: "bad_request", message: error.message });
    else throw error;
  } finally {
    ctx.res.off("close", abort);
  }
}

export const sessionNavigationRoutes: Route[] = [
  { method: "POST", path: "/v1/session-navigation", auth: "source", handle: (ctx) => handle(ctx, "navigation") },
  { method: "POST", path: "/v1/session-navigation/page", auth: "source", handle: (ctx) => handle(ctx, "page") },
  { method: "POST", path: "/v1/session-navigation/resolve", auth: "source", handle: (ctx) => handle(ctx, "resolve") },
];
