import { sendJson } from "../http.ts";
import { swallowAs } from "../../util/errors.ts";
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

function parseRecord(v: unknown): Omit<EgressAuditRecord, "ts"> | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const host = str(r.host);
  const verdict = str(r.verdict);
  if (!host || !verdict) return null;
  const via = str(r.via);
  const peerIp = str(r.peerIp);
  const principalId = str(r.principalId);
  const tenant = r.tenant === undefined ? bootTenant() : str(r.tenant);
  if (tenant === undefined || !isTenantId(tenant)) return null;
  return {
    source: "proxy",
    host,
    allowed: verdict === "ok",
    verdict,
    scopeLabel: (str(r.scopeLabel) ?? "unknown") as EgressAuditRecord["scopeLabel"],
    ...(via !== undefined ? { via } : {}),
    ...(peerIp !== undefined ? { peerIp } : {}),
    ...(principalId !== undefined ? { principalId } : {}),
    tenant,
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
  const boot = bootTenant();
  const lookup = deps.sessions?.tenantLookup;
  const exists = async (tenant: string): Promise<boolean> =>
    tenant === boot ||
    ((await lookup?.exists(tenant).catch(swallowAs(`egress audit: tenant ${tenant} lookup`, false))) ?? false);
  const byTenant = new Map<string, Array<Omit<EgressAuditRecord, "ts">>>();
  for (const raw of records) {
    const parsed = parseRecord(raw);
    const tenant = parsed?.tenant;
    if (!parsed || !tenant) continue;
    const { tenant: _tenant, ...record } = parsed;
    const batch = byTenant.get(tenant);
    if (batch) batch.push(record);
    else byTenant.set(tenant, [record]);
  }
  let accepted = 0;
  for (const [tenant, batch] of byTenant) {
    if (!(await exists(tenant))) continue;
    const sink = deps.egressAudit;
    const ok = await inTenant(tenant, async () => {
      for (const record of batch) sink.record(record);
      return true;
    }).catch(swallowAs(`egress audit: records for tenant ${tenant}`, false));
    if (ok) accepted += batch.length;
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
