import type { CapabilityClaims } from "../auth/capability-token.ts";
import { verifyPortalIdentity } from "../auth/portal-identity.ts";
import { VIEWER_ATTESTATION_HEADER } from "../deploy/access-token.ts";
import type { Deployment } from "../deploy/deploy-store.ts";
import { samePerson } from "../directory/person.ts";
import { tokenFor, type ConnectorTokenSource } from "../loops/sources/adapter.ts";
import { errMessage } from "../util/errors.ts";
import { providerForHost } from "../connectors/oauth.ts";
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

const READ_METHODS = new Set(["GET", "HEAD"]);

interface ConnectorBrokerRequest extends Omit<BrokerRequest, "credential"> {
  connector?: unknown;
  viewer?: unknown;
}

export async function brokerConnectorCall(opts: {
  claims: CapabilityClaims;
  body: ConnectorBrokerRequest;
  loadDeployment: (id: string) => Promise<Pick<Deployment, "id" | "createdBy" | "connectors"> | null>;
  tokens: ConnectorTokenSource;
  attestationKey: string;
  fetchImpl: BrokerFetch;
  audit?: BrokerAudit;
}): Promise<BrokerResult> {
  const { claims, body } = opts;
  const host = typeof body.connector === "string" ? body.connector.toLowerCase() : "";
  const method = (typeof body.method === "string" ? body.method : "GET").toUpperCase();
  const rawUrl = typeof body.url === "string" ? body.url : "";
  const viewer =
    typeof body.viewer === "string"
      ? (await verifyPortalIdentity(body.viewer, opts.attestationKey, Date.now()))?.p
      : undefined;
  const parsed = URL.canParse(rawUrl) ? new URL(rawUrl) : null;
  let viewerLabel = "(none)";
  if (viewer) viewerLabel = viewer;
  else if (body.viewer !== undefined) viewerLabel = "(invalid)";
  const record = (action: string, status: string, outcome?: string): void =>
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
        `viewer:${viewerLabel}`,
        ...(outcome ? [outcome] : []),
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
  const loan = deployment.connectors;
  if (!loan?.hosts.includes(host))
    return deny(403, "connector_not_lent", "the publisher has not lent this connector to the app");
  if (claims.deploymentVersion !== loan.version)
    return deny(
      403,
      "loan_for_other_version",
      `the publisher lent this connector to version ${loan.version}; they must lend it again to the running version`,
    );
  if (!parsed) return deny(400, "bad_url", "url is not a valid absolute URL");
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password)
    return deny(403, "scheme_not_allowed", "only plain https targets are allowed");
  if (parsed.hostname.toLowerCase() !== host)
    return deny(403, "host_not_allowed", "url host is not the connector's host");
  if (!brokerPathAllowed(parsed.pathname)) return deny(403, "path_not_allowed", "url path is not allowed");
  const read = READ_METHODS.has(method) && !providerForHost(host)?.config.writesOverGet;
  if (!read && !samePerson(viewer, deployment.createdBy))
    return deny(
      403,
      "publisher_viewer_required",
      `${method} acts as the publisher, so it needs the publisher's own signed-in visit: forward the ${VIEWER_ATTESTATION_HEADER} request header as "viewer"`,
    );
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
