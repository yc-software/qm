import { createComposioAdapter } from "../../connectors/composio.ts";
import { orgId, orgScope } from "../../config.ts";
import { personalScope } from "../../types.ts";
import { personKey } from "../../directory/person.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { sendJson } from "../http.ts";
import { activePrincipal, audit } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

async function complete(ctx: ApiCtx): Promise<void> {
  const { deps, res, req, url } = ctx;
  const principalId = personKey(
    typeof req.headers["x-consent-clicker"] === "string" ? req.headers["x-consent-clicker"] : "",
  );
  if (
    !ctx.auth ||
    ctx.capability ||
    !principalId ||
    req.headers["x-consent-clicker-org"] !== orgId() ||
    !deps.identity ||
    !(await activePrincipal(deps, principalId))
  )
    return sendJson(res, 403, { error: "authenticated_browser_required" });
  if (!deps.keychain || !deps.acl || !deps.auditLog) return sendJson(res, 503, { error: "not_configured" });
  const scopeId = personalScope(principalId);
  const granted = new Set(
    (
      await deps.acl.grantsOfKind(
        "service-cred",
        [{ id: principalId, type: "internal" }],
        scopeId,
        orgScope(),
        principalEntitledToScope,
      )
    ).map((g) => parseRef(g.ref).id),
  );
  const providers = (await deps.keychain.listServiceCredentials(orgScope())).filter(
    (c) => c.provider === "composio" && c.enabled && c.hasSecret && granted.has(c.slug),
  );
  const requested = ctx.params.credential ?? url.searchParams.get("credential");
  const defaultProvider = providers.length === 1 ? providers[0] : undefined;
  const provider = requested ? providers.find((c) => c.slug === requested) : defaultProvider;
  const sessionUri = url.searchParams.get("session_uri");
  if (!provider || !sessionUri || sessionUri.length > 4096) return sendJson(res, 400, { error: "invalid_completion" });
  const secret = await deps.keychain.getServiceCredentialSecret(orgScope(), provider.slug);
  if (!secret?.enabled || secret.provider !== "composio" || secret.delivery !== "broker")
    return sendJson(res, 403, { error: "provider_unavailable" });
  try {
    const adapter = createComposioAdapter({ apiKey: secret.secret, authorize: async () => undefined });
    const connection = await adapter.complete({ tenantId: orgId(), principalId, scopeId }, sessionUri);
    await deps.keychain.saveConnection(principalId, { provider: "composio", credential: provider.slug, ...connection });
    audit(deps, { principalId, action: "integration.connected", resource: connection.toolkit, scopeLabel: scopeId });
    return sendJson(res, 200, { status: "connected" });
  } catch {
    return sendJson(res, 400, {
      error: "completion_failed",
      message: "Connection not registered. Do not retry an uncertain completion; request a fresh connection.",
    });
  }
}

export const integrationCompletionRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/connectors/composio/complete/:credential", auth: "source", handle: complete },
  { method: "GET", path: "/v1/connectors/composio/complete", auth: "source", handle: complete },
];
