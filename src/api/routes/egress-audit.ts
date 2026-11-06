import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import type { EgressAuditRecord } from "../../admin/egress-audit-sink.ts";
import { bootTenant } from "../../tenants/boot.ts";
import { isTenantId } from "../../tenants/context.ts";
import { inTenant } from "../../tenants/claim.ts";

const MAX_BATCH = 500;
const MAX_FIELD = 512;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_FIELD) : undefined;
}

type Parsed = Omit<EgressAuditRecord, "ts" | "tenant">;

function recordTenant(r: Record<string, unknown>): string | undefined {
  if (r.tenant === undefined) return bootTenant();
  return typeof r.tenant === "string" && isTenantId(r.tenant) ? r.tenant : undefined;
}

function parseRecord(v: unknown): { tenant: string; record: Parsed } | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const host = str(r.host);
  const verdict = str(r.verdict);
  const tenant = recordTenant(r);
  if (!host || !verdict || !tenant) return null;
  return { tenant, record: fields(r, host, verdict) };
}

function fields(r: Record<string, unknown>, host: string, verdict: string): Parsed {
  const via = str(r.via);
  const peerIp = str(r.peerIp);
  const principalId = str(r.principalId);
  return {
    source: "proxy",
    host,
    allowed: verdict === "ok",
    verdict,
    scopeLabel: (str(r.scopeLabel) ?? "unknown") as EgressAuditRecord["scopeLabel"],
    ...(via !== undefined ? { via } : {}),
    ...(peerIp !== undefined ? { peerIp } : {}),
    ...(principalId !== undefined ? { principalId } : {}),
    ...(typeof r.port === "number" && Number.isInteger(r.port) && r.port > 0 && r.port <= 65535
      ? { port: r.port }
      : {}),
  };
}

async function ingestEgressAudit(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.egressAudit) return sendJson(res, 501, { error: "not_configured", message: "no egress audit sink wired" });
  const records = (body as { records?: unknown })?.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_BATCH) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `records must be a non-empty array of at most ${MAX_BATCH}`,
    });
  }
  const sink = deps.egressAudit;
  const byTenant = new Map<string, Parsed[]>();
  for (const parsed of records.map(parseRecord)) {
    if (parsed) byTenant.set(parsed.tenant, [...(byTenant.get(parsed.tenant) ?? []), parsed.record]);
  }
  let accepted = 0;
  for (const [tenant, batch] of byTenant) {
    await inTenant(tenant, async () => batch.forEach((record) => sink.record(record)));
    accepted += batch.length;
  }
  return sendJson(res, 200, { accepted, rejected: records.length - accepted });
}

export const egressAuditRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/egress-audit",
    actor: "system",
    auth: "source",
    tenant: "none",
    handle: ingestEgressAudit,
  },
];
