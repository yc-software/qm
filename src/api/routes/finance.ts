import { randomBytes } from "node:crypto";
import { TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD } from "../../auth/capability-token.ts";
import { parseNetSuiteTbaSecret, netSuiteTbaAuthorization } from "../../credentials/netsuite-tba.ts";
import { realBrokerFetch, type BrokerFetch } from "../credential-broker.ts";
import { sendJson } from "../http.ts";
import type { ApiCtx, Route } from "./route.ts";
import { scopeId as makeScopeId } from "../../types.ts";
import { orgId as configOrgId } from "../../config.ts";

export interface SuiteQLRow {
  [column: string]: unknown;
}

export interface SuiteQLResponse {
  rows: SuiteQLRow[];
  totalResults?: number;
  hasMore?: boolean;
  metadata?: Record<string, unknown>;
}

export async function executeSuiteQL(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!capability) {
    return sendJson(res, 401, { error: "unauthorized", message: "tool-broker capability token required" });
  }

  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const query = typeof payload.query === "string" ? payload.query.trim() : "";
  const params = payload.params ?? {};
  const state = typeof payload.state === "string" ? payload.state : undefined;
  const planSha256 = typeof payload.planSha256 === "string" ? payload.planSha256 : undefined;
  const simulatedRows = Array.isArray(payload.simulatedRows) ? (payload.simulatedRows as SuiteQLRow[]) : undefined;

  // Enforce S4_SOURCE invariant if state is supplied
  if (state && state !== "S4_SOURCE") {
    return sendJson(res, 403, {
      error: "closegate_violation",
      message: `SuiteQL queries can only execute in S4_SOURCE state. Currently in ${state}.`,
    });
  }

  if (!query && !simulatedRows) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "SuiteQL query text is required",
    });
  }

  // If offline/simulated rows are provided directly in payload, return them with metadata
  if (simulatedRows) {
    return sendJson(res, 200, {
      rows: simulatedRows,
      totalResults: simulatedRows.length,
      hasMore: false,
      metadata: { source: "simulated", state: state ?? "S4_SOURCE", planSha256 },
    });
  }

  // Look up NetSuite credential from serviceCreds
  if (!deps.serviceCreds) {
    return sendJson(res, 503, {
      error: "service_credentials_unavailable",
      message: "QM service credentials store is not configured",
    });
  }

  const orgScope = makeScopeId("org", configOrgId());
  const cred = await deps.serviceCreds.getServiceCredentialSecret(orgScope, "netsuite");
  if (!cred || !cred.secret) {
    return sendJson(res, 404, {
      error: "netsuite_credential_not_found",
      message: "NetSuite service credential ('netsuite') is not configured in QM",
    });
  }

  try {
    const tba = parseNetSuiteTbaSecret(cred.secret);
    const host = cred.host || `${tba.accountId.toLowerCase().replace(/_/g, "-")}.suitetalk.api.netsuite.com`;
    const url = `https://${host}/services/rest/query/v1/suiteql?limit=1000&offset=0`;
    const nonce = randomBytes(16).toString("hex");
    const timestamp = Date.now();
    const authHeader = netSuiteTbaAuthorization(tba, url, "POST", nonce, timestamp);

    const fetchImpl: BrokerFetch = deps.brokerFetch ?? realBrokerFetch;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "transient",
        Authorization: authHeader,
      },
      body: JSON.stringify({ q: query, params }),
    });

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      return sendJson(res, 502, {
        error: "invalid_netsuite_response",
        message: "Failed to parse NetSuite SuiteQL response as JSON",
        status: response.status,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      return sendJson(res, response.status, {
        error: "netsuite_query_failed",
        details: json,
      });
    }

    const items = Array.isArray(json.items) ? (json.items as SuiteQLRow[]) : [];
    const totalResults = typeof json.totalResults === "number" ? json.totalResults : items.length;
    const hasMore = Boolean(json.hasMore);

    return sendJson(res, 200, {
      rows: items,
      totalResults,
      hasMore,
      metadata: {
        source: "ERP_GL",
        state: state ?? "S4_SOURCE",
        planSha256,
      },
    });
  } catch (err) {
    return sendJson(res, 500, {
      error: "suiteql_execution_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const suiteqlRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "POST",
    path: "/v1/finance/suiteql",
    auth: { aud: [TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD] },
    handle: executeSuiteQL,
  },
  {
    method: "POST",
    path: "/v1/tools/suiteql",
    auth: { aud: [TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD] },
    handle: executeSuiteQL,
  },
];
