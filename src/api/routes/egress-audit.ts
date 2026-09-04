import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import type { EgressAuditRecord } from "../../admin/egress-audit-sink.ts";

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
  let accepted = 0;
  for (const raw of records) {
    const parsed = parseRecord(raw);
    if (!parsed) continue;
    deps.egressAudit.record(parsed);
    accepted++;
  }
  return sendJson(res, 200, { accepted, rejected: records.length - accepted });
}

export const egressAuditRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/egress-audit", auth: "source", handle: ingestEgressAudit },
];
