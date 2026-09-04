import { orgId as configOrgId } from "../../config.ts";
import {
  authorizeUrl,
  exchangeCode,
  openOAuthState,
  PROVIDERS,
  sealOAuthState,
  createSecretClientResolver,
  generateCodeVerifier,
  codeChallengeS256,
  type OAuthClientResolver,
  type AccountType,
} from "../../connectors/oauth.ts";
import { bestOAuthTokenStatus, CONNECTOR_STATUS_ACCOUNT_TYPES } from "../../credentials/connector-status.ts";
import type { OAuthTokenStatus } from "../../credentials/keychain.ts";
import { createEnvSecretSource } from "../../credentials/secret-source.ts";
import type { ServerDeps } from "../deps.ts";
import { personKey, samePerson } from "../../directory/person.ts";
import { errMessage } from "../../util/errors.ts";
import { normalizeInboundExpiresAt } from "../expiry.ts";
import { sendJson, sendRedirect } from "../http.ts";
import { audit } from "./shared.ts";
import type { ApiCtx, BaseCtx, Route } from "./route.ts";

const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;
function oauthStateSecret(deps: ServerDeps, signingSecret: string | undefined): string {
  const value = deps.oauthStateSecret ?? signingSecret;
  if (!value) throw new Error("OAuth state secret required");
  return value;
}

export function resolverFor(deps: ServerDeps): OAuthClientResolver {
  return (
    deps.resolveClient ?? createSecretClientResolver(deps.oauthEnv ? createEnvSecretSource(deps.oauthEnv) : undefined)
  );
}

function parseAccountType(v: string | null | undefined): AccountType {
  return v === "personal" || v === "company" ? v : "default";
}

async function providerConfigured(deps: ServerDeps, provider: string): Promise<boolean> {
  try {
    await resolverFor(deps)(provider, {});
    return true;
  } catch {
    return false;
  }
}

function parseOAuthRoute(pathname: string): { provider: string; action: "start" | "callback" } | null {
  const prefix = "/v1/connectors/oauth/";
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2) return null;
  const [provider, action] = parts;
  if (!provider || (action !== "start" && action !== "callback")) return null;
  return { provider: decodeURIComponent(provider), action };
}

function safeReturnTo(value: string | null): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return undefined;
  return value;
}

type HostStatus = OAuthTokenStatus & { host: string };

function latestRefreshFailure(
  entries: ReadonlyArray<Pick<OAuthTokenStatus, "refreshFailedAt" | "refreshError">>,
): Pick<OAuthTokenStatus, "refreshFailedAt" | "refreshError"> {
  let latest: Pick<OAuthTokenStatus, "refreshFailedAt" | "refreshError"> = {};
  for (const entry of entries) {
    if (
      entry.refreshFailedAt !== undefined &&
      (latest.refreshFailedAt === undefined || entry.refreshFailedAt > latest.refreshFailedAt)
    ) {
      latest = {
        refreshFailedAt: entry.refreshFailedAt,
        ...(entry.refreshError ? { refreshError: entry.refreshError } : {}),
      };
    }
  }
  return latest;
}

async function connectorProviderStatus(deps: ServerDeps, principalId: string): Promise<Record<string, unknown>> {
  const providers: Record<string, unknown> = {};
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const hosts = (await Promise.all(
      provider.hosts.map(async (host) => {
        const probed = await Promise.all(
          CONNECTOR_STATUS_ACCOUNT_TYPES.map(
            async (at) =>
              (await deps.connectorTokens?.connectorTokenStatus(host, principalId, at)) ?? { connected: false },
          ),
        );
        const best = bestOAuthTokenStatus(probed);
        return { host, ...best };
      }),
    )) as HostStatus[];
    const configured = await providerConfigured(deps, name);
    const reconnectHosts = hosts.filter((h) => h.needsReconnect);
    const latestFailure = latestRefreshFailure(hosts);
    providers[name] = {
      hosts,
      connected: hosts.some((h) => h.connected && !h.needsReconnect),
      ...(reconnectHosts.length ? { needsReconnect: true } : {}),
      ...latestFailure,
      configured,
      available: configured,
      consentMode: provider.consentMode,
    };
  }
  return providers;
}

async function oauthCallback(ctx: BaseCtx): Promise<void> {
  const { res, deps, secret, url, pathname } = ctx;
  const oauthRoute = parseOAuthRoute(pathname)!;
  if (!deps.connectorTokens)
    return sendJson(res, 501, { error: "not_configured", message: "connector token store not wired" });
  const code = url.searchParams.get("code") ?? "";
  const stateParam = url.searchParams.get("state") ?? "";
  const providerError = url.searchParams.get("error");
  if (providerError) return sendJson(res, 400, { error: "oauth_denied", message: providerError });
  if (!code || !stateParam) return sendJson(res, 400, { error: "bad_request", message: "code and state required" });
  let state;
  try {
    state = await openOAuthState(stateParam, {
      secret: oauthStateSecret(deps, secret),
      maxAgeMs: OAUTH_STATE_MAX_AGE_MS,
    });
    if (state.provider !== oauthRoute.provider) throw new Error("OAuth provider mismatch");
    if (state.orgId !== undefined && state.orgId !== configOrgId()) {
      throw new Error("OAuth state is for a different org");
    }
    if (
      !deps.replayDedupe ||
      !(await deps.replayDedupe.claim(`oauth:${state.nonce}`, state.issuedAt + OAUTH_STATE_MAX_AGE_MS))
    ) {
      throw new Error("OAuth state was already used or replay protection is unavailable");
    }
    const accountType = state.accountType ?? "default";
    const client = await resolverFor(deps)(oauthRoute.provider, { accountType });
    const { hosts, token } = await exchangeCode(oauthRoute.provider, code, state.redirectUri, {
      client,
      fetchImpl: deps.oauthFetch,
      accountType,
      ...(state.codeVerifier ? { codeVerifier: state.codeVerifier } : {}),
    });
    if (!token.accessToken) throw new Error("oauth exchange returned an empty access token");
    const stamped = { ...token, clientRef: client.clientRef, accountType, orgId: configOrgId() };
    for (const host of hosts)
      await deps.connectorTokens.setConnectorToken(host, state.principalId, stamped, accountType);
    audit(deps, {
      principalId: state.principalId,
      action: "connector.oauth.connected",
      resource: oauthRoute.provider,
      scopeLabel: state.principalId,
    });
    if (state.consentLinkId && deps.consentLinks) {
      await deps.consentLinks.redeem(state.consentLinkId).catch(() => null);
    }
    if (state.returnTo) {
      const dest = new URL(state.returnTo, "http://localhost");
      dest.searchParams.set("connector", oauthRoute.provider);
      dest.searchParams.set("status", "connected");
      return sendRedirect(res, `${dest.pathname}${dest.search}${dest.hash}`);
    }
    return sendJson(res, 200, { ok: true, provider: oauthRoute.provider, principalId: state.principalId, hosts });
  } catch (e) {
    return sendJson(res, 400, { error: "oauth_callback_failed", message: errMessage(e) });
  }
}

async function principalHasProvider(deps: ServerDeps, provider: string, principalId: string): Promise<boolean> {
  const p = PROVIDERS[provider];
  if (!p || !deps.connectorTokens) return false;
  for (const host of p.hosts) {
    for (const at of CONNECTOR_STATUS_ACCOUNT_TYPES) {
      const st = await deps.connectorTokens
        .connectorTokenStatus(host, principalId, at)
        .catch(() => ({ connected: false }) as OAuthTokenStatus);
      if (st.connected && !st.needsReconnect) return true;
    }
  }
  return false;
}

async function consentRedeem(ctx: ApiCtx): Promise<void> {
  const { res, deps, secret, url } = ctx;
  if (!deps.consentLinks || !deps.connectorTokens) return sendJson(res, 404, { error: "not_found" });
  const clicker = personKey(ctx.req.headers["x-consent-clicker"] as string | undefined);
  if (!clicker) return sendJson(res, 401, { error: "unauthorized", message: "sign in to complete this connection" });
  const linkId = decodeURIComponent(ctx.params.linkId ?? "");
  const peeked = await deps.consentLinks.peek(linkId);
  if (!peeked.ok) {
    return sendJson(res, 200, { status: peeked.reason === "expired" ? "expired" : "invalid" });
  }
  const rec = peeked.rec;
  if (rec.orgId !== undefined && rec.orgId !== configOrgId()) return sendJson(res, 200, { status: "invalid" });
  if (!PROVIDERS[rec.provider]) return sendJson(res, 200, { status: "invalid" });
  if (!samePerson(clicker, rec.principalId)) {
    const clickerConnected = await principalHasProvider(deps, rec.provider, clicker);
    audit(deps, {
      principalId: clicker,
      action: "connector.oauth.consent.wrong_recipient",
      resource: rec.provider,
      scopeLabel: rec.principalId,
    });
    return sendJson(res, 200, {
      status: "wrong_recipient",
      provider: rec.provider,
      intended: rec.principalId,
      clickerConnected,
    });
  }
  try {
    const client = await resolverFor(deps)(rec.provider, { accountType: rec.accountType });
    if (client.redirectAllowlist && !client.redirectAllowlist.includes(rec.redirectUri)) {
      return sendJson(res, 400, {
        error: "redirect_not_allowed",
        message: "redirectUri is not registered for this client",
      });
    }
    const returnTo = safeReturnTo(url.searchParams.get("returnTo")) ?? rec.returnTo;
    const codeVerifier = PROVIDERS[rec.provider]?.pkce ? generateCodeVerifier() : undefined;
    const state = await sealOAuthState(
      {
        provider: rec.provider,
        principalId: rec.principalId,
        redirectUri: rec.redirectUri,
        orgId: configOrgId(),
        ...(rec.accountType !== "default" ? { accountType: rec.accountType } : {}),
        clientRef: client.clientRef,
        ...(returnTo ? { returnTo } : {}),
        ...(codeVerifier ? { codeVerifier } : {}),
        consentLinkId: linkId,
      },
      { secret: oauthStateSecret(deps, secret) },
    );
    const consentUrl = authorizeUrl(rec.provider, {
      redirectUri: rec.redirectUri,
      state,
      client,
      accountType: rec.accountType,
      ...(codeVerifier ? { codeChallenge: codeChallengeS256(codeVerifier) } : {}),
    });
    audit(deps, {
      principalId: rec.principalId,
      action: "connector.oauth.consent.redeem",
      resource: rec.provider,
      scopeLabel: rec.principalId,
    });
    return sendJson(res, 200, { status: "authorize", authorizeUrl: consentUrl });
  } catch (e) {
    return sendJson(res, 501, { error: "oauth_not_configured", message: errMessage(e) });
  }
}

async function consentMint(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!deps.consentLinks) return sendJson(res, 404, { error: "not_found" });
  if (!capability)
    return sendJson(res, 401, { error: "unauthorized", message: "oauth-consent capability token required" });
  const b = body as {
    provider?: unknown;
    accountType?: unknown;
    redirectUri?: unknown;
    returnTo?: unknown;
    intendedPrincipalId?: unknown;
  };
  const provider = typeof b.provider === "string" ? b.provider : "";
  if (!PROVIDERS[provider])
    return sendJson(res, 404, { error: "not_found", message: `unknown OAuth provider: ${provider}` });
  const accountType = parseAccountType(typeof b.accountType === "string" ? b.accountType : null);
  const base = deps.publicUrl ? deps.publicUrl.replace(/\/$/, "") : "";
  const intendedPrincipalId = personKey(typeof b.intendedPrincipalId === "string" ? b.intendedPrincipalId : "");
  if (intendedPrincipalId && !samePerson(intendedPrincipalId, capability.actorId)) {
    const selfConnect = deps.portalUrl
      ? `send them ${deps.portalUrl.replace(/\/$/, "")}/connect/${encodeURIComponent(provider)}/self-connect (no token needed; signing in there is what identifies them)`
      : "tell them to open the Connectors page in the org's web UI and connect it themselves";
    return sendJson(res, 400, {
      error: "bad_request",
      message: `consent links are only mintable for yourself — to get someone else connected, ${selfConnect}`,
    });
  }
  let redirectUri = "";
  if (base) redirectUri = `${base}/v1/connectors/oauth/${provider}/callback`;
  else if (typeof b.redirectUri === "string") redirectUri = b.redirectUri;
  if (!redirectUri)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "no public callback configured (set PUBLIC_WEB_URL) and no redirectUri supplied",
    });
  let client;
  try {
    client = await resolverFor(deps)(provider, { accountType });
  } catch (e) {
    return sendJson(res, 501, { error: "oauth_not_configured", message: errMessage(e) });
  }
  if (base) {
    if (client.redirectAllowlist && !client.redirectAllowlist.includes(redirectUri)) {
      return sendJson(res, 400, {
        error: "redirect_not_allowed",
        message: "redirectUri is not registered for this client",
      });
    }
  } else if (!client.redirectAllowlist || !client.redirectAllowlist.includes(redirectUri)) {
    return sendJson(res, 400, {
      error: "redirect_not_allowed",
      message: "set PUBLIC_WEB_URL, or supply a redirectUri registered in the client's redirect allowlist",
    });
  }
  const returnTo =
    safeReturnTo(typeof b.returnTo === "string" ? b.returnTo : null) ?? (deps.portalUrl ? "/connectors" : undefined);
  const { linkId } = await deps.consentLinks.mint({
    principalId: capability.actorId,
    orgId: configOrgId(),
    provider,
    accountType,
    redirectUri,
    ...(returnTo ? { returnTo } : {}),
  });
  audit(deps, {
    principalId: capability.actorId,
    action: "connector.oauth.consent.mint",
    resource: provider,
    scopeLabel: capability.actorId,
  });
  const connectPath = `/connect/redeem/${linkId}?p=${encodeURIComponent(provider)}`;
  return sendJson(res, 200, {
    provider,
    accountType,
    connectPath,
    connectUrl: base ? `${base}${connectPath}` : connectPath,
  });
}

async function oauthStart(ctx: ApiCtx): Promise<void> {
  const { res, deps, secret, url, pathname } = ctx;
  const oauthRoute = parseOAuthRoute(pathname)!;
  if (!deps.connectorTokens)
    return sendJson(res, 501, { error: "not_configured", message: "connector token store not wired" });
  const provider = PROVIDERS[oauthRoute.provider];
  if (!provider)
    return sendJson(res, 404, { error: "not_found", message: `unknown OAuth provider: ${oauthRoute.provider}` });
  const principalId = url.searchParams.get("principalId") ?? "";
  const redirectUri = url.searchParams.get("redirectUri") ?? "";
  if (!principalId || !redirectUri)
    return sendJson(res, 400, { error: "bad_request", message: "principalId and redirectUri required" });
  const accountType = parseAccountType(url.searchParams.get("accountType"));
  try {
    const client = await resolverFor(deps)(oauthRoute.provider, { accountType });
    if (client.redirectAllowlist && !client.redirectAllowlist.includes(redirectUri)) {
      return sendJson(res, 400, {
        error: "redirect_not_allowed",
        message: "redirectUri is not registered for this client",
      });
    }
    const codeVerifier = provider.pkce ? generateCodeVerifier() : undefined;
    const state = await sealOAuthState(
      {
        provider: oauthRoute.provider,
        principalId,
        redirectUri,
        orgId: configOrgId(),
        ...(accountType !== "default" ? { accountType } : {}),
        clientRef: client.clientRef,
        ...(safeReturnTo(url.searchParams.get("returnTo"))
          ? { returnTo: safeReturnTo(url.searchParams.get("returnTo")) }
          : {}),
        ...(codeVerifier ? { codeVerifier } : {}),
      },
      { secret: oauthStateSecret(deps, secret) },
    );
    const consentUrl = authorizeUrl(oauthRoute.provider, {
      redirectUri,
      state,
      client,
      accountType,
      ...(codeVerifier ? { codeChallenge: codeChallengeS256(codeVerifier) } : {}),
    });
    audit(deps, {
      principalId,
      action: "connector.oauth.start",
      resource: oauthRoute.provider,
      scopeLabel: principalId,
    });
    return sendJson(res, 200, {
      provider: oauthRoute.provider,
      principalId,
      accountType,
      hosts: provider.hosts,
      authorizeUrl: consentUrl,
    });
  } catch (e) {
    return sendJson(res, 501, { error: "oauth_not_configured", message: errMessage(e) });
  }
}

async function oauthStatus(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  if (!deps.connectorTokens)
    return sendJson(res, 501, { error: "not_configured", message: "connector token store not wired" });
  const principalId = url.searchParams.get("principalId") ?? "";
  if (!principalId) return sendJson(res, 400, { error: "bad_request", message: "principalId required" });
  audit(deps, { principalId, action: "connector.oauth.status", resource: "connectors", scopeLabel: principalId });
  return sendJson(res, 200, { principalId, providers: await connectorProviderStatus(deps, principalId) });
}

export async function oauthRevoke(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, capability } = ctx;
  if (!deps.connectorTokens)
    return sendJson(res, 501, { error: "not_configured", message: "connector token store not wired" });
  const b = body as Record<string, unknown>;
  let principalId = typeof b.principalId === "string" ? b.principalId : "";
  if (capability) {
    principalId = personKey(principalId) || capability.actorId;
    if (!samePerson(principalId, capability.actorId)) {
      const members = capability.keychainMembers ?? [];
      if (!members.some((m) => samePerson(m.id, principalId))) {
        return sendJson(res, 400, {
          error: "bad_request",
          message: "principalId must be a member of this conversation",
        });
      }
    }
  }
  const providerName = typeof b.provider === "string" ? b.provider : "";
  const host = typeof b.host === "string" ? b.host : "";
  if (!principalId || (!providerName && !host)) {
    return sendJson(res, 400, { error: "bad_request", message: "principalId and provider or host required" });
  }
  if (providerName) {
    const provider = PROVIDERS[providerName];
    if (!provider)
      return sendJson(res, 404, { error: "not_found", message: `unknown OAuth provider: ${providerName}` });
    for (const h of provider.hosts)
      for (const at of CONNECTOR_STATUS_ACCOUNT_TYPES)
        await deps.connectorTokens.deleteConnectorToken(h, principalId, at);
    audit(deps, { principalId, action: "connector.oauth.revoked", resource: providerName, scopeLabel: principalId });
    return sendJson(res, 200, { ok: true, principalId, provider: providerName, hosts: provider.hosts });
  }
  for (const at of CONNECTOR_STATUS_ACCOUNT_TYPES)
    await deps.connectorTokens.deleteConnectorToken(host, principalId, at);
  audit(deps, { principalId, action: "connector.oauth.revoked", resource: host, scopeLabel: principalId });
  return sendJson(res, 200, { ok: true, principalId, host });
}

async function setToken(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.connectorTokens)
    return sendJson(res, 501, { error: "not_configured", message: "connector token store not wired" });
  const b = body as Record<string, unknown>;
  const host = typeof b.host === "string" ? b.host : "";
  const principalId = typeof b.principalId === "string" ? b.principalId : "";
  const accessToken = typeof b.accessToken === "string" ? b.accessToken : "";
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) return sendJson(res, 400, { error: "bad_request", message: expiresAt.message });
  if (!host || !principalId || !accessToken) {
    return sendJson(res, 400, { error: "bad_request", message: "host, principalId, accessToken required" });
  }
  await deps.connectorTokens.setConnectorToken(host, principalId, {
    accessToken,
    ...(typeof b.refreshToken === "string" ? { refreshToken: b.refreshToken } : {}),
    ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
  });
  audit(deps, { principalId, action: "connector.token.set", resource: host, scopeLabel: principalId });
  return sendJson(res, 200, { ok: true });
}

async function catalog(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const entries = await Promise.all(
    Object.entries(PROVIDERS).map(async ([name, p]) => ({
      provider: name,
      hosts: p.hosts,
      scopes: p.scopes,
      consentMode: p.consentMode,
      redirectPath: p.redirectPath,
      setupGuide: p.setupGuide,
      configured: await providerConfigured(deps, name),
    })),
  );
  return sendJson(res, 200, { catalog: entries });
}

export const connectorRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { match: (m, p) => m === "GET" && parseOAuthRoute(p)?.action === "callback", auth: "public", handle: oauthCallback },
];

export const connectorRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/connectors/oauth/consent/mint", auth: { aud: "oauth-consent" }, handle: consentMint },
  { method: "GET", path: "/v1/connectors/oauth/consent/redeem/:linkId", auth: "source", handle: consentRedeem },
  { match: (m, p) => m === "GET" && parseOAuthRoute(p)?.action === "start", auth: "source", handle: oauthStart },
  { method: "GET", path: "/v1/connectors/oauth/status", auth: "source", handle: oauthStatus },
  { method: "POST", path: "/v1/connectors/oauth/revoke", auth: "either", handle: oauthRevoke },
  { method: "POST", path: "/v1/connectors/token", auth: "source", handle: setToken },
  { method: "GET", path: "/v1/connectors/catalog", auth: "source", handle: catalog },
];
