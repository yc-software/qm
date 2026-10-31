import { parseScopeId, type ScopeId } from "../../../types.ts";
import { sendJson } from "../../http.ts";
import { audit, requireScopedAdmin } from "../shared.ts";
import { type ApiCtx } from "../route.ts";

const EGRESS_LIST_LIMIT = 1000;
const ERRORS_LIST_LIMIT = 200;
const AUDIT_TAIL_LIMIT = 200;
const AUDIT_FILTERED_LIMIT = 2000;

export async function egress(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "egress.read", resource: "egress", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const q = orgWide ? { limit: EGRESS_LIST_LIMIT } : { scopeId: scope, limit: EGRESS_LIST_LIMIT };
  const brokerRows = ((await deps.credentialUsage?.list(q)) ?? []).map((s) => ({
    ts: s.ts,
    source: "broker" as string,
    host: s.host,
    scopeLabel: s.scopeLabel,
    principalId: s.principalId,
    allowed: s.status !== "denied",
    status: s.status,
    slug: s.slug,
    ...(s.upstreamStatus !== undefined ? { upstreamStatus: s.upstreamStatus } : {}),
  }));
  const firewallRows = ((await deps.egressAudit?.list(q)) ?? []).map((e) => ({
    ts: e.ts,
    source: e.source,
    host: e.host,
    scopeLabel: e.scopeLabel,
    allowed: e.allowed,
    status: e.verdict ?? (e.allowed ? "ok" : "denied"),
    ...(e.principalId !== undefined ? { principalId: e.principalId } : {}),
    ...(e.port !== undefined ? { port: e.port } : {}),
    ...(e.via !== undefined ? { via: e.via } : {}),
    ...(e.peerIp !== undefined ? { peerIp: e.peerIp } : {}),
  }));
  const records = [...brokerRows, ...firewallRows].sort((a, b) => b.ts - a.ts).slice(0, EGRESS_LIST_LIMIT);
  const denied = records.filter((r) => !r.allowed).length;
  const hosts = new Set(records.map((r) => r.host).filter(Boolean)).size;
  const bySource = { broker: brokerRows.length, firewall: firewallRows.length };
  return sendJson(res, 200, { scopeId: scope, records, total: records.length, denied, hosts, bySource });
}

export async function listAdminErrors(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "errors.read", resource: "errors", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const sessionId = url.searchParams.get("sessionId") || undefined;
  const filters = {
    ...(orgWide ? {} : { scopeId: scope }),
    ...(sessionId ? { sessionId } : {}),
  };
  const rawLimit = Number(url.searchParams.get("limit") ?? ERRORS_LIST_LIMIT);
  const rawOffset = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "limit must be a positive integer and offset a non-negative integer.",
    });
  }
  const limit = Math.min(rawLimit, ERRORS_LIST_LIMIT);
  const total = (await deps.errors?.count(filters)) ?? 0;
  if (url.searchParams.get("count")) return sendJson(res, 200, { scopeId: scope, total });
  const lastOffset = total ? Math.floor((total - 1) / limit) * limit : 0;
  const offset = Math.min(rawOffset, lastOffset);
  const errors = (await deps.errors?.list({ ...filters, limit, offset })) ?? [];
  return sendJson(res, 200, { scopeId: scope, errors, total, limit, offset });
}

export async function listAdminAudit(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const authz = await requireScopedAdmin(ctx);
  if (!authz) return;
  const { actor, scope } = authz;
  audit(deps, { principalId: actor.id, action: "audit.read", resource: "audit", scopeLabel: scope });
  const orgWide = parseScopeId(scope).kind === "org";
  const action = ctx.url.searchParams.get("action") ?? undefined;
  const resourceContains = ctx.url.searchParams.get("resource") ?? undefined;
  const filtered = action !== undefined || resourceContains !== undefined;
  const cap = filtered ? AUDIT_FILTERED_LIMIT : AUDIT_TAIL_LIMIT;
  const requested = Math.floor(Number(ctx.url.searchParams.get("limit")));
  const fallback = filtered ? cap : AUDIT_TAIL_LIMIT;
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, cap) : fallback;
  const events = (
    (await deps.auditLog?.tail({
      limit,
      ...(orgWide ? {} : { scopeLabel: scope as ScopeId }),
      ...(action === undefined ? {} : { action }),
      ...(resourceContains === undefined ? {} : { resourceContains }),
    })) ?? []
  ).map((e) => ({
    ts: e.at,
    principalId: e.principalId,
    action: e.action,
    scopeLabel: e.scopeLabel,
    resource: e.resource,
    ...(e.status ? { status: e.status } : {}),
  }));
  return sendJson(res, 200, { scopeId: scope, events });
}
