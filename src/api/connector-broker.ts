import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { Deployment } from "../deploy/deploy-store.ts";
import { tokenFor, type ConnectorTokenSource } from "../loops/sources/adapter.ts";
import { errMessage } from "../util/errors.ts";
import {
  brokerPathAllowed,
  callerHeaders,
  relayedResult,
  UPSTREAM_UNREACHABLE,
  type BrokerAudit,
  type BrokerFetch,
  type BrokerFetchResponse,
  type BrokerRequest,
  type BrokerResult,
} from "./credential-broker.ts";

interface ConnectorBrokerRequest extends Omit<BrokerRequest, "credential"> {
  connector?: unknown;
}

export async function brokerConnectorCall(opts: {
  claims: CapabilityClaims;
  body: ConnectorBrokerRequest;
  loadDeployment: (id: string) => Promise<Pick<Deployment, "id" | "createdBy" | "connectors" | "public"> | null>;
  tokens: ConnectorTokenSource;
  fetchImpl: BrokerFetch;
  audit?: BrokerAudit;
}): Promise<BrokerResult> {
  const { claims, body } = opts;
  const host = typeof body.connector === "string" ? body.connector.toLowerCase() : "";
  const method = (typeof body.method === "string" ? body.method : "GET").toUpperCase();
  const rawUrl = typeof body.url === "string" ? body.url : "";
  const parsed = URL.canParse(rawUrl) ? new URL(rawUrl) : null;
  const record = (action: string, status: string, outcome: string): void =>
    opts.audit?.({
      principalId: claims.actorId,
      action,
      resource: host || "(none)",
      scopeLabel: claims.scopeId,
      status,
      detail: [
        `deployment:${claims.deployment ?? "(none)"}`,
        method,
        parsed?.pathname ?? "(invalid-url)",
        outcome,
      ].join(" "),
    });
  const deny = (httpStatus: number, code: string, message: string): BrokerResult => {
    record("connector.broker.denied", "denied", code);
    return { status: httpStatus, json: { error: code, message } };
  };

  if (!host || !rawUrl)
    return { status: 400, json: { error: "bad_request", message: "connector (host) and url are required" } };
  const deployment = claims.deployment ? await opts.loadDeployment(claims.deployment) : null;
  if (!deployment || deployment.id !== claims.deployment)
    return deny(403, "not_entitled", "only a published app can borrow its publisher's connectors");
  if (!deployment.connectors?.includes(host) || deployment.public)
    return deny(403, "connector_not_lent", "the publisher has not lent this connector to the app");
  if (!parsed) return deny(400, "bad_url", "url is not a valid absolute URL");
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password)
    return deny(403, "scheme_not_allowed", "only plain https targets are allowed");
  if (parsed.hostname.toLowerCase() !== host)
    return deny(403, "host_not_allowed", "url host is not the connector's host");
  if (!brokerPathAllowed(parsed.pathname)) return deny(403, "path_not_allowed", "url path is not allowed");
  const token = await tokenFor(opts.tokens, host, deployment.createdBy);
  if (!token) return deny(409, "connector_unavailable", "the publisher's connection is missing or needs reconnecting");

  let resp: BrokerFetchResponse;
  try {
    resp = await opts.fetchImpl(parsed.toString(), {
      method,
      headers: { ...callerHeaders(body.headers), authorization: `Bearer ${token}` },
      ...(typeof body.body === "string" ? { body: body.body } : {}),
    });
  } catch (err) {
    record("connector.broker.error", "error", errMessage(err));
    return UPSTREAM_UNREACHABLE;
  }
  record("connector.broker.use", "ok", `upstream:${resp.status}`);
  return relayedResult(resp);
}
