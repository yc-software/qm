import {
  DESKTOP_LAUNCH_SCRIPT,
  DESKTOP_LAUNCH_SCRIPT_HASH,
  desktopChallenge,
  mintDesktopLogin,
  openDesktopLogin,
} from "./desktop-login.ts";
import { createSurfaceConfigs } from "./surface-config.ts";
import { INVITE_LOGIN_SCRIPT, INVITE_LOGIN_SCRIPT_HASH } from "./invite-login.ts";
import { isDnsLabel } from "../../chassis/src/dns-label.ts";
import { reportBackendError, withRequestContext } from "../../chassis/src/error-reporting.ts";
import "./instrument.ts";
import { provisionTrustedAdmin } from "./trusted-admin.ts";
import {
  CARD_SCENE_PATH,
  cardPage,
  connectErrorHtml,
  connectPage,
  connectWrongRecipientHtml,
  LOCK_ICON,
  noWorkspaceHtml,
  notConfiguredHtml,
  serveCardScene,
  setCardBrandSource,
  signInErrorHtml,
} from "./pages.ts";
import { createHash } from "node:crypto";
import { createServer, METHODS, type IncomingMessage, type ServerResponse } from "node:http";
import { failUpgrade, isWebSocketUpgrade, responseOnSocket } from "../../chassis/src/websocket-relay.ts";
import type { Duplex } from "node:stream";
import { ADMIN_LOGIN_SCRIPT, ADMIN_LOGIN_SCRIPT_HASH, openAdminLogin } from "./admin-login.ts";
import { LRUCache } from "lru-cache";
import { createCanonicalResolver, IdentityRejected } from "./canonical.ts";
import { createSignedInNames } from "./signed-in-name.ts";
import { createTrustedEntry, trustedEntryConfig } from "./trusted-entry.ts";
import { coreAppHostTenant, createAppHandoff } from "./app-handoff.ts";
import {
  coreEmailTenants,
  coreWorkspace,
  createTenantChoice,
  verifiedEmail,
  type SignInTenant,
  type TrustedSignIn,
  type VerifiedSignIn,
} from "./tenant-choice.ts";
import { answerPreflight, parseAllowedOrigins, prepareCors } from "./cors.ts";
import {
  deriveKey,
  seal,
  openSession,
  openImpersonation,
  openTmp,
  setCookie,
  sessionCookieHeaders,
  clearCookie,
  readCookie,
  withoutCookies,
  signedOutCookies,
  randomToken,
  safeEqual,
  sanitizeReturnTo,
  type SessionClaims,
  type ImpersonationClaims,
  type TmpClaims,
  sessionLifetime,
} from "./session.ts";
import {
  pkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  resolvePrincipal,
  AdmissionRefusedError,
  verifyIdToken,
  type OidcConfig,
  type PrincipalRule,
  hostedDomainHint,
} from "./oidc.ts";
import {
  proxyToDeployment,
  proxyToUpstream,
  proxyToAppHost,
  relayUpgradeToAppHost,
  FORWARD_AGENT_API_HEADERS,
  FORWARD_DEPLOYMENT_GIT_HEADERS,
  FORWARD_DEPLOYMENT_LAYER_HEADERS,
  FORWARD_OAUTH_HEADERS,
  FORWARD_BROKER_HEADERS,
  FORWARD_WEBHOOK_HEADERS,
  INTERNAL_HEADERS,
} from "./proxy.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { coreClaimStore, claimOnce, ClaimStoreUnavailableError } from "../../chassis/src/claims.ts";
import { coreEmailAdmission } from "../../chassis/src/external-members.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import {
  json,
  escapeHtml,
  sendBuffered,
  serveFavicon,
  readBody,
  PayloadTooLargeError,
  sameOriginRequest as sameOriginFor,
  originOf,
  isLoopbackUrl,
  isSecureOrLoopbackUrl,
  KEEP_ALIVE_TIMEOUT_MS,
} from "../../chassis/src/http.ts";
import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
  isMissingOrPlaceholder,
} from "../../chassis/src/env.ts";
import { isDeploymentGitRoute } from "../../chassis/src/deployment-git.ts";

const PUBLIC_URL = (process.env.PUBLIC_WEB_URL ?? "http://localhost:8097").replace(/\/$/, "");
const SESSION_SECRET = process.env.PORTAL_SESSION_SECRET;
const { ttl: SESSION_TTL_S, max: SESSION_MAX_TTL_S } = sessionLifetime();
const SESSION_RENEW_AFTER_S = Math.floor(SESSION_TTL_S / 2);
const APPS_DOMAIN = process.env.PORTAL_APPS_DOMAIN || process.env.DEPLOY_APPS_DOMAIN || undefined;
const COOKIE_DOMAIN = process.env.PORTAL_COOKIE_DOMAIN || undefined;
const STALE_COOKIE_DOMAIN =
  !COOKIE_DOMAIN && APPS_DOMAIN
    ? derivedCookieDomain(hostOf(process.env.PUBLIC_WEB_URL ?? ""), APPS_DOMAIN)
    : undefined;
const IS_PROD = process.env.NODE_ENV === "production";
const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");
const ORIGIN = originOf(PUBLIC_URL);
const API_ALLOWED_ORIGINS = parseAllowedOrigins(process.env.PORTAL_API_ALLOWED_ORIGINS);
const LOCAL_AUTH_BYPASS_REQUESTED = process.env.PORTAL_LOCAL_AUTH_BYPASS === "1";
const LOCAL_AUTH_BYPASS = LOCAL_AUTH_BYPASS_REQUESTED && !IS_PROD && isLoopbackUrl(PUBLIC_URL);
const LOCAL_AUTH_PRINCIPAL = process.env.PORTAL_DEV_PRINCIPAL || process.env.USER || "dev-admin";
const NEUTRAL_ACCENT = "#4f46e5";
const surfaceConfigs = createSurfaceConfigs(NEUTRAL_ACCENT, async (tenant, sub) => {
  const path = withSourceAuthNonce("/v1/surface-config", CORE_SIGNING_SECRET);
  const r = await fetch(`${CORE}${path}`, {
    headers: { ...signedHeaders(CORE_SIGNING_SECRET, "GET", path), ...(sub ? portalIdentityHeaders(sub, tenant) : {}) },
    signal: AbortSignal.timeout(2_000),
  });
  if (!r.ok) return null;
  const body = (await r.json()) as {
    branding?: { accent?: unknown; selfLabel?: unknown };
    modelProviderConfigured?: unknown;
  };
  return {
    ...(typeof body.branding?.accent === "string" ? { accent: body.branding.accent } : {}),
    ...(typeof body.branding?.selfLabel === "string" ? { selfLabel: body.branding.selfLabel } : {}),
    ...(typeof body.modelProviderConfigured === "boolean"
      ? { modelProviderConfigured: body.modelProviderConfigured }
      : {}),
  };
});
setCardBrandSource(() => surfaceConfigs.selfLabel());

function isSlackIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname;
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

const OIDC: OidcConfig = {
  authEndpoint: process.env.OIDC_AUTH_ENDPOINT ?? "https://slack.com/openid/connect/authorize",
  tokenEndpoint: process.env.OIDC_TOKEN_ENDPOINT ?? "https://slack.com/api/openid.connect.token",
  userinfoEndpoint: process.env.OIDC_USERINFO_ENDPOINT ?? "https://slack.com/api/openid.connect.userInfo",
  clientId: process.env.OIDC_CLIENT_ID ?? "",
  clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  scopes: process.env.OIDC_SCOPES ?? "openid profile email",
  redirectUri: `${PUBLIC_URL}/auth/callback`,
  issuer: process.env.OIDC_ISSUER ?? "https://slack.com",
  jwksUri: process.env.OIDC_JWKS_URI ?? "https://slack.com/openid/connect/keys",
  expectedTeamId: process.env.PORTAL_EXPECTED_TEAM_ID || undefined,
  prompt: process.env.OIDC_PROMPT || undefined,
  hostedDomain: hostedDomainHint(process.env.OIDC_ISSUER ?? "https://slack.com", process.env.OIDC_ALLOWED_EMAIL_DOMAIN),
};
const OIDC_JWKS_CONFIGURED = Boolean(process.env.OIDC_JWKS_URI?.trim());

const AUTH_BROKER_UPSTREAM = (process.env.AUTH_BROKER_UPSTREAM ?? "").replace(/\/$/, "");
const AUTH_BROKER_PREFIX = (process.env.AUTH_BROKER_PREFIX ?? "/idp").replace(/\/$/, "");
const BROKER_PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/authorize" },
  { method: "POST", path: "/authorize" },
  { method: "GET", path: "/verify" },
  { method: "POST", path: "/verify" },
];

export function brokerRouteFor(method: string, pathname: string): string | null {
  if (!AUTH_BROKER_UPSTREAM || !AUTH_BROKER_PREFIX || !pathname.startsWith(`${AUTH_BROKER_PREFIX}/`)) return null;
  const rest = pathname.slice(AUTH_BROKER_PREFIX.length);
  return BROKER_PUBLIC_ROUTES.some((route) => route.method === method && route.path === rest) ? rest : null;
}

const XFF_TRUSTED_HOPS = Math.max(0, Math.trunc(Number(process.env.PORTAL_XFF_TRUSTED_HOPS ?? 0)) || 0);
const ON_FLY = Boolean(process.env.FLY_APP_NAME?.trim());

export function clientIpOf(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress || "unknown";
  if (ON_FLY) {
    const fly = req.headers["fly-client-ip"];
    return typeof fly === "string" && fly.trim() ? fly.trim() : socket;
  }
  if (XFF_TRUSTED_HOPS === 0) return socket;
  const forwarded = req.headers["x-forwarded-for"];
  const hops = (typeof forwarded === "string" ? forwarded : "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - XFF_TRUSTED_HOPS] ?? socket;
}

const PRINCIPAL_RULE: PrincipalRule = {
  requireCoreAdmission: Boolean(AUTH_BROKER_UPSTREAM),
  claim: (process.env.OIDC_PRINCIPAL_CLAIM ?? "email") as PrincipalRule["claim"],
  allowedEmailDomain: process.env.OIDC_ALLOWED_EMAIL_DOMAIN || undefined,
  allowedEmails: process.env.OIDC_ALLOWED_EMAILS?.split(",")
    .map((email) => email.trim())
    .filter(Boolean),
};

const DEV_SECRET = "dev-only-insecure-portal-session-secret";
const sessionKey = deriveKey(SESSION_SECRET ?? DEV_SECRET, "portal.session.v1");
const tmpKey = deriveKey(SESSION_SECRET ?? DEV_SECRET, "portal.tmp.v1");
const impersonateKey = deriveKey(SESSION_SECRET ?? DEV_SECRET, "portal.impersonate.v1");
const trustedOidc = trustedEntryConfig(process.env, PUBLIC_URL);
const trustedSignInLabel = trustedOidc ? process.env.PORTAL_TRUSTED_OIDC_LABEL?.trim() || undefined : undefined;
const trustedAdminEnabled = process.env.PORTAL_TRUSTED_OIDC_ADMIN === "1";
if (
  trustedAdminEnabled &&
  (!trustedOidc ||
    !CORE_SIGNING_SECRET ||
    !PORTAL_IDENTITY_SECRET ||
    PORTAL_IDENTITY_SECRET.length < 32 ||
    PORTAL_IDENTITY_SECRET === CORE_SIGNING_SECRET)
)
  throw new Error("Trusted administrator provisioning requires trusted OIDC and a distinct portal identity secret");
const claimTrusted = (key: string, expiresAt: number) =>
  claimOnce(coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal"), key, expiresAt);
const trustedEntry = trustedOidc ? createTrustedEntry(trustedOidc, SESSION_SECRET ?? DEV_SECRET, claimTrusted) : null;
const workspaceFor = coreWorkspace(CORE, CORE_SIGNING_SECRET);
const IMPERSONATE_TTL_S = Number(process.env.PORTAL_IMPERSONATE_TTL_S ?? 3600);
const appHandoff = createAppHandoff({
  publicUrl: PUBLIC_URL,
  lookup: coreAppHostTenant(CORE, CORE_SIGNING_SECRET),
  handoffKey: deriveKey(SESSION_SECRET ?? DEV_SECRET, "portal.handoff.v1"),
  claim: (jti) => claimTrusted(`handoff:${jti}`, Date.now() + 120_000),
  session: (req) => currentSession(req),
  signOut: (res) => setSession(res, signedOutCookies(SECURE_COOKIES, COOKIE_DOMAIN, STALE_COOKIE_DOMAIN)),
  signInApp: (res, who) => setAuthenticatedSession(res, who.sub, who.name, false, who.t, false),
  page: (res, status, html) => sendHtml(res, status, html),
  errorHtml: (detail) => signInErrorHtml(detail),
});

const TMP_TTL_S = 600;
const LOCAL_LOGOUT_COOKIE = "portal_local_logout";
const CONSUMED_STATES_MAX = 10_000;
export const consumedStates = new LRUCache<string, number>({ max: CONSUMED_STATES_MAX, ttl: 2 * TMP_TTL_S * 1000 });
export function consumeState(state: string): boolean {
  const now = Date.now();
  const existing = consumedStates.get(state);
  if (existing !== undefined && existing > now) return false;
  consumedStates.set(state, now + TMP_TTL_S * 1000);
  return true;
}

const ADMIN_TTL_MS = 60_000;
const ADMIN_PROBE_TIMEOUT_MS = 6_500;
const ADMIN_PROBE_ATTEMPTS = 2;
const ADMIN_PROBE_RETRY_DELAY_MS = 250;
const adminCache = new LRUCache<string, Map<string, boolean>>({ max: 10_000, ttl: ADMIN_TTL_MS });

function portalIdentityHeaders(sub: string, t?: string): Record<string, string> {
  return PORTAL_IDENTITY_SECRET
    ? {
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
          { p: sub, ...(t ? { t } : {}), exp: Date.now() + 60_000 },
          PORTAL_IDENTITY_SECRET,
        ),
      }
    : {};
}

async function adminProbeAttempt(sub: string, tenant?: string): Promise<boolean | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ADMIN_PROBE_TIMEOUT_MS);
  try {
    const path = withSourceAuthNonce("/v1/admin/whoami", CORE_SIGNING_SECRET);
    const headers = {
      ...signedHeaders(CORE_SIGNING_SECRET, "GET", path),
      "x-admin-actor": `${sub}@${ORG}`,
      ...portalIdentityHeaders(sub, tenant),
    };
    const r = await fetch(`${CORE}${path}`, { headers, signal: ctrl.signal });
    if (!r.ok) {
      console.warn(`[portal] admin probe returned HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as { isAdmin?: unknown };
    if (typeof j.isAdmin !== "boolean") {
      console.warn("[portal] admin probe returned an invalid admin status");
      return null;
    }
    return j.isAdmin;
  } catch (error) {
    console.warn(`[portal] admin probe failed: ${errMessage(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isAdmin(sub: string, tenant?: string): Promise<boolean> {
  const hit = adminCache.get(sub)?.get(tenant ?? "");
  if (hit !== undefined) return hit;
  for (let attempt = 0; attempt < ADMIN_PROBE_ATTEMPTS; attempt++) {
    const isAdmin = await adminProbeAttempt(sub, tenant);
    if (isAdmin === null) {
      if (attempt + 1 < ADMIN_PROBE_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, ADMIN_PROBE_RETRY_DELAY_MS));
      continue;
    }
    const known = adminCache.get(sub);
    if (known) known.set(tenant ?? "", isAdmin);
    else adminCache.set(sub, new Map([[tenant ?? "", isAdmin]]));
    return isAdmin;
  }
  return false;
}

const CANONICAL_TIMEOUT_MS = 4_000;

const canonicalPrincipal = createCanonicalResolver(async (sub, tenant) => {
  const path = withSourceAuthNonce(`/v1/principals/${encodeURIComponent(sub)}/canonical`, CORE_SIGNING_SECRET);
  const r = await fetch(`${CORE}${path}`, {
    headers: { ...signedHeaders(CORE_SIGNING_SECRET, "GET", path), ...portalIdentityHeaders(sub, tenant) },
    signal: AbortSignal.timeout(CANONICAL_TIMEOUT_MS),
  });
  if ([401, 403, 404].includes(r.status)) throw new IdentityRejected(`HTTP ${r.status}`);
  if (!r.ok) {
    console.warn(`[portal] canonical principal lookup returned HTTP ${r.status}`);
    return null;
  }
  const body = (await r.json()) as { canonicalId?: unknown; displayName?: unknown; storedName?: unknown };
  const id = typeof body.canonicalId === "string" && body.canonicalId ? body.canonicalId : sub;
  const label = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 200) : "";
  const name = label || (id !== sub && id.includes("@") ? id : "");
  const stored = typeof body.storedName === "string" && body.storedName.trim() !== "";
  return { id, ...(name ? { name } : {}), ...(stored ? { stored: true as const } : {}) };
});

const signedInNames = createSignedInNames({
  core: CORE,
  signingSecret: CORE_SIGNING_SECRET,
  identityHeaders: portalIdentityHeaders,
  timeoutMs: CANONICAL_TIMEOUT_MS,
});

function identityUnavailable(req: IncomingMessage, res: ServerResponse): void {
  if (wantsHtml(req))
    return sendHtml(
      res,
      503,
      connectPage({ title: "Service unavailable", body: "Could not confirm your identity. Try again in a moment." }),
    );
  json(res, 503, { error: "identity_unavailable", message: "could not confirm your identity, try again in a moment" });
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function sendHtml(res: ServerResponse, status: number, html: string, csp = PAGE_CSP): void {
  sendBuffered(
    res,
    status,
    {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
    html,
  );
}

const sameOriginRequest = (req: IncomingMessage) => sameOriginFor(req, ORIGIN);

function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function derivedCookieDomain(portalHost: string, appsDomain: string): string | undefined {
  const host = portalHost.toLowerCase();
  return host.includes(".") && appsDomain.toLowerCase().endsWith(`.${host}`) ? host : undefined;
}

export function hostIsWithinDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, "");
  return !!h && !!d && (h === d || h.endsWith(`.${d}`));
}

export function isPrivateNetworkUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".flycast") || host.endsWith(".local")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  return false;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("127.")
  );
}

function localDevSession(req: IncomingMessage, nowMs = Date.now(), ignoreLogout = false): SessionClaims | null {
  if (!LOCAL_AUTH_BYPASS) return null;
  if (!isLoopbackAddress(req.socket.remoteAddress)) return null;
  if (!ignoreLogout && readCookie(req.headers.cookie, LOCAL_LOGOUT_COOKIE) === "1") return null;
  const now = Math.floor(nowMs / 1000);
  return { k: "session", sub: LOCAL_AUTH_PRINCIPAL, org: ORG, iat: now, exp: now + SESSION_TTL_S };
}

function currentSession(req: IncomingMessage): SessionClaims | null {
  return storedSession(req) ?? localDevSession(req);
}

function storedSession(req: IncomingMessage): SessionClaims | null {
  return openSession(readCookie(req.headers.cookie, "portal_session"), sessionKey, Date.now(), ORG, SESSION_MAX_TTL_S);
}

async function handleConsentRedeem(
  res: ServerResponse,
  o: { corePath: string; session: SessionClaims },
): Promise<void> {
  const path = withSourceAuthNonce(o.corePath, CORE_SIGNING_SECRET);
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, "GET", path),
    "x-consent-clicker": o.session.sub,
    "x-consent-clicker-org": o.session.org,
    ...portalIdentityHeaders(o.session.sub, o.session.t),
  };
  const errorPage = (detail: string) => connectErrorHtml(detail);
  let data: { status?: string; authorizeUrl?: string; provider?: string; clickerConnected?: boolean };
  try {
    const r = await fetch(`${CORE}${path}`, { headers });
    data = (await r.json().catch(() => ({}))) as typeof data;
  } catch {
    return sendHtml(
      res,
      502,
      errorPage("We couldn't reach the connection service. Please try the link again in a moment."),
    );
  }
  switch (data.status) {
    case "authorize":
      if (!data.authorizeUrl)
        return sendHtml(res, 502, errorPage("The connection service returned an unexpected response."));
      res.writeHead(302, { location: data.authorizeUrl, "cache-control": "no-store" });
      return void res.end();
    case "wrong_recipient":
      return sendHtml(
        res,
        200,
        connectWrongRecipientHtml({ provider: data.provider ?? "", alreadyConnected: !!data.clickerConnected }),
      );
    case "expired":
      return sendHtml(res, 200, errorPage("This connect link has expired. Ask the agent for a fresh one."));
    default:
      return sendHtml(
        res,
        200,
        errorPage("This connect link is invalid or was already used. Ask the agent for a fresh one."),
      );
  }
}

function readRequestBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = "";
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      b += c;
      if (b.length > maxBytes) {
        over = true;
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => !over && resolve(b));
    req.on("error", reject);
  });
}

async function handleSecretDrop(
  req: IncomingMessage,
  res: ServerResponse,
  o: { method: string; corePath: string; session: SessionClaims },
): Promise<void> {
  const isPost = o.method === "POST";
  let rawBody = "";
  if (isPost) {
    try {
      rawBody = await readRequestBody(req);
    } catch {
      return json(res, 413, { error: "too_large", message: "that value is too large" });
    }
  }
  const path = withSourceAuthNonce(o.corePath, CORE_SIGNING_SECRET);
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, isPost ? "POST" : "GET", path, rawBody),
    "x-drop-owner": o.session.sub,
    "x-drop-owner-org": o.session.org,
    ...portalIdentityHeaders(o.session.sub, o.session.t),
  };
  let r: Response;
  try {
    r = await fetch(`${CORE}${path}`, {
      method: isPost ? "POST" : "GET",
      headers,
      ...(isPost ? { body: rawBody } : {}),
    });
  } catch {
    if (isPost)
      return json(res, 502, {
        error: "unreachable",
        message: "couldn't reach the credential service, try again in a moment",
      });
    return sendHtml(res, 502, connectPage({ title: "Service unavailable", body: "Try the link again in a moment." }));
  }
  const bodyText = await r.text();
  const ct = r.headers.get("content-type") ?? (isPost ? "application/json" : "text/html; charset=utf-8");
  res.writeHead(r.status, { "content-type": ct, "cache-control": "no-store" });
  return void res.end(bodyText);
}

async function handleSelfConnect(res: ServerResponse, o: { provider: string; session: SessionClaims }): Promise<void> {
  const errorPage = (detail: string) => connectErrorHtml(detail);
  const redirectUri = `${PUBLIC_URL}/v1/connectors/oauth/${encodeURIComponent(o.provider)}/callback`;
  const qs = new URLSearchParams({ principalId: o.session.sub, redirectUri, returnTo: "/connectors" });
  const path = withSourceAuthNonce(
    `/v1/connectors/oauth/${encodeURIComponent(o.provider)}/start?${qs.toString()}`,
    CORE_SIGNING_SECRET,
  );
  try {
    const r = await fetch(`${CORE}${path}`, {
      headers: {
        ...signedHeaders(CORE_SIGNING_SECRET, "GET", path),
        ...portalIdentityHeaders(o.session.sub, o.session.t),
      },
    });
    const data = (await r.json().catch(() => ({}))) as { authorizeUrl?: string; message?: string };
    if (!r.ok) console.warn(`[portal] self-connect start returned HTTP ${r.status}: ${data.message ?? "no message"}`);
    if (data.authorizeUrl) {
      res.writeHead(302, { location: data.authorizeUrl, "cache-control": "no-store" });
      return void res.end();
    }
    return sendHtml(
      res,
      200,
      errorPage(data.message ?? "We couldn't start the connection. This app may not be configured."),
    );
  } catch (error) {
    console.warn(`[portal] self-connect start failed: ${errMessage(error)}`);
    return sendHtml(res, 502, errorPage("We couldn't reach the connection service. Please try again in a moment."));
  }
}

async function coreImpersonate(
  action: "start" | "stop",
  admin: string,
  target: string,
  tenant?: string,
): Promise<{ ok: boolean; status: number; displayName?: string; message?: string }> {
  const path = withSourceAuthNonce(`/v1/admin/impersonate${action === "stop" ? "/stop" : ""}`, CORE_SIGNING_SECRET);
  const body = JSON.stringify({ target });
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, "POST", path, body),
    "x-admin-actor": `${admin}@${ORG}`,
    ...portalIdentityHeaders(admin, tenant),
  };
  try {
    const r = await fetch(`${CORE}${path}`, { method: "POST", headers, body });
    const j = (await r.json().catch(() => ({}))) as { displayName?: string; message?: string };
    return { ok: r.ok, status: r.status, displayName: j.displayName, message: j.message };
  } catch (e) {
    return { ok: false, status: 502, message: errMessage(e) };
  }
}

function isOAuthPublicPassthrough(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  if (/^\/v1\/connectors\/oauth\/[^/]+\/callback$/.test(pathname)) return true;
  return false;
}

function hasAgentCapability(req: IncomingMessage): boolean {
  const value = req.headers["x-agent-capability"];
  return typeof value === "string" && value.trim().length > 0;
}

function isSourceSignedPassthrough(method: string, pathname: string): boolean {
  if (pathname === "/v1/deployment-layer") return method === "GET" || method === "PUT";
  return method === "POST" && pathname === "/v1/egress-audit";
}

function loginProviderCookie(sub: string): string[] {
  if (!trustedOidc || !trustedSignInLabel) return [];
  const issuerHash = createHash("sha256").update(trustedOidc.issuer).digest("hex");
  return [
    sub.startsWith(`oidc:${issuerHash}:`)
      ? setCookie("portal_login_provider", issuerHash, {
          path: "/",
          maxAge: 365 * 24 * 60 * 60,
          secure: SECURE_COOKIES,
        })
      : clearCookie("portal_login_provider", "/", SECURE_COOKIES),
  ];
}

function sessionCookieSet(value: string, sub: string, domainWide = true): string[] {
  const attrs = {
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: SECURE_COOKIES,
    ...(COOKIE_DOMAIN && domainWide ? { domain: COOKIE_DOMAIN } : {}),
  };
  return [...sessionCookieHeaders(value, attrs, STALE_COOKIE_DOMAIN), ...loginProviderCookie(sub)];
}

function setSession(res: ServerResponse, headers: string[]): void {
  const earlier = res.getHeader("set-cookie");
  const prior = earlier ? [earlier].flat().map(String) : [];
  res.setHeader("set-cookie", [...prior, ...headers]);
}

function renewSessionCookie(req: IncomingMessage, res: ServerResponse): SessionClaims | null {
  const session = storedSession(req);
  if (!session) return null;
  if (session.appOnly) return session;
  const now = Math.floor(Date.now() / 1000);
  if (now - session.iat < SESSION_RENEW_AFTER_S) return session;
  const authenticatedAt = session.auth ?? session.iat;
  const renewed: SessionClaims = {
    ...session,
    auth: authenticatedAt,
    iat: now,
    exp: Math.min(now + SESSION_TTL_S, authenticatedAt + SESSION_MAX_TTL_S),
  };
  setSession(res, sessionCookieSet(seal(renewed, sessionKey), renewed.sub));
  return renewed;
}

export interface CoreHandoff {
  serves(method: string, pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse): void;
  shell(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

let core: CoreHandoff | undefined;

const server = createServer((req, res) => {
  const startedAt = performance.now();
  let errorLogged = false;
  res.once("finish", () => {
    if (res.statusCode >= 500 && !errorLogged)
      console.error(
        "[portal] %d %s response (%d ms)",
        res.statusCode,
        METHODS.includes(req.method ?? "") ? req.method : "?",
        Math.round(performance.now() - startedAt),
      );
  });
  void withRequestContext("portal", req, res, () => handle(req, res)).catch((err: unknown) => {
    errorLogged = true;
    reportBackendError(err);
    console.error("[portal] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    else res.end();
  });
});

function appLabelOf(host: string | undefined): string | null {
  if (!APPS_DOMAIN) return null;
  const requestHost = (host ?? "").toLowerCase().split(":")[0]!;
  const apps = APPS_DOMAIN.toLowerCase();
  if (requestHost === hostOf(PUBLIC_URL)) return null;
  if (requestHost === apps) return "";
  return requestHost.endsWith(`.${apps}`) ? requestHost.slice(0, -apps.length - 1) : null;
}

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  socket.on("error", () => socket.destroy());
  const res = responseOnSocket(req, socket);
  if (!res) return void socket.destroy();
  const label = appLabelOf(req.headers.host);
  if (label !== null && isDnsLabel(label) && isWebSocketUpgrade(req))
    return relayUpgradeToAppHost(req, res, { socket, head }, CORE, clientIpOf(req));
  void withRequestContext("portal", req, res, () => handle(req, res)).catch((error: unknown) =>
    failUpgrade(socket, "portal-websocket", error),
  );
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const rawTarget = req.url ?? "/";
  const url = URL.parse(rawTarget, "http://portal.local");
  if (!url) return json(res, 400, { error: "bad_request", message: "malformed request target" });
  const pathname = url.pathname;

  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");

  const appLabel = appLabelOf(req.headers.host);
  if (appLabel !== null) {
    if (!isDnsLabel(appLabel)) return json(res, 404, { error: "not_found" });
    if (await appHandoff.redeem(req, res, url)) return;
    return proxyToAppHost(req, res, CORE, clientIpOf(req));
  }

  const crossOrigin = prepareCors(req, res, pathname, API_ALLOWED_ORIGINS.origins);
  if (crossOrigin && method === "OPTIONS") return answerPreflight(res);

  const brokerPath = brokerRouteFor(method, pathname);
  const reauthentication =
    (method === "GET" &&
      ["/auth/login", "/auth/callback", "/auth/trusted/login", "/auth/trusted/callback"].includes(pathname)) ||
    (method === "POST" && pathname === "/auth/logout") ||
    brokerPath !== null;
  if (currentSession(req)?.appOnly && !reauthentication) {
    return json(res, 403, { error: "app_only_session", message: "this sign-in only permits access to shared apps" });
  }

  const surfaceViewer = currentSession(req);
  void surfaceConfigs.refresh(surfaceViewer?.t, surfaceViewer?.sub);

  if (method === "GET" && pathname === CARD_SCENE_PATH) return serveCardScene(res);

  if (method === "GET" && (pathname === "/healthz" || pathname === "/readyz"))
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: "" }, ["accept"]);

  if (method === "GET" && (pathname === "/favicon.ico" || pathname === "/favicon.svg")) {
    return serveFavicon(
      res,
      {
        svg: process.env.PORTAL_FAVICON_SVG,
        emoji: process.env.PORTAL_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F",
      },
      "max-age=86400",
    );
  }

  if (pathname === "/auth/host" && method === "GET") return appHandoff.start(req, res, url);
  if (pathname === "/auth/login" && method === "GET") return authLogin(req, res, url);
  if (pathname === "/auth/callback" && method === "GET") return authCallback(req, res, url);
  if (pathname === "/auth/tenant" && method === "POST") return tenantChoice.choose(req, res);
  if (pathname === "/auth/tenant" && method === "GET") return tenantChoice.search(req, res, url);
  if (pathname.startsWith("/auth/trusted/") && method === "GET") return trustedAuth(req, res, url);
  if (pathname === "/auth/desktop" || pathname === "/auth/desktop/redeem") return desktopLogin(req, res, url);
  if (pathname === "/auth/invite") return inviteLogin(req, res);
  if (pathname === "/auth/admin-login") return adminLogin(req, res);
  if (pathname === "/auth/signed-out" && method === "GET") {
    if (currentSession(req))
      return sendHtml(
        res,
        409,
        connectPage({
          title: "Still signed in",
          body: "Use Sign out from the account menu to end this session.",
          action: `<a class="btn primary" href="/">Back to the portal</a>`,
          icon: LOCK_ICON,
        }),
      );
    return sendHtml(
      res,
      200,
      connectPage({
        title: "Signed out",
        body: "You have signed out of this portal.",
        action: `<a class="btn primary" href="/auth/login">Sign in</a>`,
        icon: LOCK_ICON,
      }),
    );
  }
  if (pathname === "/auth/logout" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
    if (AUTH_BROKER_UPSTREAM && url.searchParams.get("everywhere") === "1") {
      const session = currentSession(req);
      if (!session) return json(res, 401, { error: "sign in" });
      if (!PORTAL_IDENTITY_SECRET) return json(res, 503, { error: "not_configured" });
      const path = withSourceAuthNonce("/v1/auth/broker/sessions/revoke", CORE_SIGNING_SECRET);
      const body = JSON.stringify({ email: session.sub });
      try {
        const response = await fetch(`${CORE}${path}`, {
          method: "POST",
          headers: {
            ...signedHeaders(CORE_SIGNING_SECRET, "POST", path, body),
            ...portalIdentityHeaders(session.sub, session.t),
          },
          body,
          signal: AbortSignal.timeout(4_000),
        });
        if (!response.ok) return json(res, 503, { error: "revocation_failed" });
      } catch {
        return json(res, 503, { error: "revocation_failed" });
      }
    }
    const signedOutSession = currentSession(req);
    const redirectTo = !AUTH_BROKER_UPSTREAM && signedOutSession ? "/auth/signed-out" : "/";
    setSession(res, [
      ...(signedOutSession ? loginProviderCookie(signedOutSession.sub) : []),
      ...signedOutCookies(SECURE_COOKIES, COOKIE_DOMAIN, STALE_COOKIE_DOMAIN),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(AUTH_BROKER_UPSTREAM ? [clearCookie("qm_idp_session", AUTH_BROKER_PREFIX, true)] : []),
      ...(LOCAL_AUTH_BYPASS && isLoopbackAddress(req.socket.remoteAddress)
        ? [setCookie(LOCAL_LOGOUT_COOKIE, "1", { path: "/", maxAge: SESSION_TTL_S, secure: SECURE_COOKIES })]
        : []),
    ]);
    if (wantsHtml(req)) {
      res.writeHead(303, { location: redirectTo, "cache-control": "no-store" });
      return void res.end();
    }
    return json(res, 200, { ok: true, redirectTo });
  }

  if (brokerPath) {
    if (method !== "GET" && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    return proxyToUpstream(
      req,
      res,
      { baseUrl: AUTH_BROKER_UPSTREAM, path: brokerPath, search: url.search, forwardCookies: true },
      FORWARD_BROKER_HEADERS,
      {
        "x-qm-client-ip": clientIpOf(req),
        cookie: (req.headers.cookie ?? "")
          .split(";")
          .map((part) => part.trim())
          .filter((part) => /^qm_idp_session=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(part))
          .join("; "),
      },
    );
  }

  const cookieSession = renewSessionCookie(req, res);
  let session = cookieSession ?? currentSession(req);
  if (session && !cookieSession) setSession(res, sessionCookieSet(seal(session, sessionKey), session.sub));
  let staleSession: SessionClaims | null = null;
  if (session && (!pathname.startsWith("/auth/") || pathname.startsWith("/auth/impersonate"))) {
    const canonical = await canonicalPrincipal(session.sub, session.t);
    if (canonical instanceof IdentityRejected) {
      console.warn(`[portal] core no longer recognises this session; signing it out: ${canonical.message}`);
      for (const cookie of signedOutCookies(SECURE_COOKIES, COOKIE_DOMAIN, STALE_COOKIE_DOMAIN))
        res.appendHeader("set-cookie", cookie);
      req.headers.cookie = withoutCookies(req.headers.cookie, new Set(["portal_session", "portal_impersonate"]));
      session = null;
    } else if (!canonical) return identityUnavailable(req, res);
    else {
      if (session.name && !canonical.stored && !canonical.stale)
        signedInNames.backfill(session.sub, session.name, session.t);
      const known = {
        ...session,
        sub: canonical.id,
        ...(!session.name && canonical.name ? { name: canonical.name } : {}),
      };
      if (canonical.stale) staleSession = known;
      session = canonical.stale ? null : known;
    }
  }

  if (pathname === "/auth/impersonate" && method === "POST") {
    if (!session) return staleSession ? identityUnavailable(req, res) : json(res, 401, { error: "sign in" });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (!(await isAdmin(session.sub, session.t)))
      return json(res, 403, { error: "forbidden", message: "admin access required" });
    const target = (url.searchParams.get("target") ?? "").trim();
    if (!target) return json(res, 400, { error: "bad_request", message: "target required" });
    const targetCanonical = await canonicalPrincipal(target, session.t);
    if (
      target === session.sub ||
      (targetCanonical && !(targetCanonical instanceof IdentityRejected) && targetCanonical.id === session.sub)
    )
      return json(res, 400, { error: "bad_request", message: "cannot impersonate yourself" });
    const result = await coreImpersonate("start", session.sub, target, session.t);
    if (!result.ok) {
      const status = result.status === 403 || result.status === 400 ? result.status : 502;
      return json(res, status, {
        error: "impersonate_failed",
        message: result.message ?? "core refused impersonation",
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const imp: ImpersonationClaims = {
      k: "impersonate",
      actor: session.sub,
      target,
      org: session.org,
      iat: now,
      exp: now + IMPERSONATE_TTL_S,
    };
    setSession(res, [
      setCookie("portal_impersonate", seal(imp, impersonateKey), {
        path: "/",
        maxAge: IMPERSONATE_TTL_S,
        secure: SECURE_COOKIES,
      }),
    ]);
    return json(res, 200, { ok: true, target, displayName: result.displayName ?? target });
  }

  if (pathname === "/auth/impersonate/stop" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    const imp = openImpersonation(readCookie(req.headers.cookie, "portal_impersonate"), impersonateKey, Date.now());
    setSession(res, [clearCookie("portal_impersonate", "/", SECURE_COOKIES)]);
    const actor = session ?? staleSession;
    if (actor && imp && imp.actor === actor.sub) await coreImpersonate("stop", actor.sub, imp.target, actor.t);
    if (wantsHtml(req)) {
      res.writeHead(303, { location: "/", "cache-control": "no-store" });
      return void res.end();
    }
    return json(res, 200, { ok: true });
  }

  const rawPath = rawTarget.split("?")[0] ?? "";
  if (/%2f|%5c|%2e%2e|\\|\x00/i.test(rawPath) || rawPath.includes("//") || pathname.includes("/..")) {
    return json(res, 400, { error: "bad_request", message: "illegal path" });
  }

  if (
    (pathname === "/v1/slack/managed/installation" && (method === "POST" || method === "DELETE")) ||
    (pathname === "/v1/slack/managed/events" && method === "POST")
  ) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: "" }, ["authorization", "content-type"]);
  }

  if (pathname === "/v1/surfaces/partner-chat/events" && method === "POST") {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: "" }, [
      "content-type",
      "content-length",
      "x-agent-app-request-timestamp",
      "x-agent-app-signature",
    ]);
  }

  if (method === "POST" && pathname === "/slack/events") {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      ...FORWARD_WEBHOOK_HEADERS,
      "content-length",
      "x-slack-retry-num",
      "x-slack-retry-reason",
    ]);
  }

  if (method === "GET" && pathname === "/v1/spend/export") {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      "authorization",
      "accept",
    ]);
  }

  if (
    method === "POST" &&
    (/^\/v1\/webhooks\/incoming\/[^/]+$/.test(pathname) || /^\/v1\/loop-ingress\/[^/]+$/.test(pathname))
  ) {
    return proxyToUpstream(
      req,
      res,
      { baseUrl: CORE, path: pathname, search: url.search },
      pathname.startsWith("/v1/loop-ingress/")
        ? [...FORWARD_WEBHOOK_HEADERS, "authorization"]
        : FORWARD_WEBHOOK_HEADERS,
    );
  }

  const consentBounce = (): void => {
    if (staleSession) return identityUnavailable(req, res);
    res.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(`${pathname}${url.search}`)}` });
    return void res.end();
  };
  const redeem = /^\/connect\/redeem\/([^/]+)$/.exec(pathname);
  if (method === "GET" && redeem) {
    if (!session) return consentBounce();
    return handleConsentRedeem(res, {
      corePath: `/v1/connectors/oauth/consent/redeem/${redeem[1]}${url.search}`,
      session,
    });
  }
  const selfConnect = /^\/connect\/([^/]+)\/self-connect$/.exec(pathname);
  if (method === "GET" && selfConnect) {
    if (!session) return consentBounce();
    return handleSelfConnect(res, { provider: decodeURIComponent(selfConnect[1] ?? ""), session });
  }

  if (isOAuthPublicPassthrough(method, pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_OAUTH_HEADERS);
  }

  const dropForm = /^\/drop\/([^/]+)\/form$/.exec(pathname);
  if (method === "GET" && dropForm) {
    if (!session) return consentBounce();
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropForm[1]}/form${url.search}`,
      session,
    });
  }
  const dropSubmit = /^\/drop\/([^/]+)$/.exec(pathname);
  if (method === "POST" && dropSubmit) {
    if (staleSession) return identityUnavailable(req, res);
    if (!session)
      return json(res, 401, {
        error: "sign in",
        message: "your session expired, re-open the link, sign in, and paste again",
      });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropSubmit[1]}${url.search}`,
      session,
    });
  }

  if (method === "POST" && pathname === "/v1/deployment/live-session") {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, [
      ...FORWARD_DEPLOYMENT_LAYER_HEADERS,
      "authorization",
    ]);
  }

  if (isDeploymentGitRoute(method, pathname)) {
    return proxyToUpstream(
      req,
      res,
      { baseUrl: CORE, path: pathname, search: url.search },
      FORWARD_DEPLOYMENT_GIT_HEADERS,
    );
  }

  if (isSourceSignedPassthrough(method, pathname)) {
    return proxyToUpstream(
      req,
      res,
      { baseUrl: CORE, path: pathname, search: url.search },
      FORWARD_DEPLOYMENT_LAYER_HEADERS,
    );
  }

  if (pathname.startsWith("/v1/") && hasAgentCapability(req)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_AGENT_API_HEADERS);
  }

  if (pathname === "/v1" || pathname.startsWith("/v1/")) return json(res, 404, { error: "not_found" });

  const seg = pathname.split("/")[1] ?? "";
  if (seg === "web-ui") {
    const stripped = pathname.slice("/web-ui".length) || "/";
    res.writeHead(308, { location: `${stripped}${url.search}`, "cache-control": "no-store" });
    return void res.end();
  }
  const isDeployment = seg === "d" || seg === "deployments";

  if (core && method === "GET") {
    if (/^\/share\/external\/[a-f0-9-]{36}(?:\/files\/[a-f0-9-]{36})?$/.test(pathname) && core.serves(method, pathname))
      return core.handle(withoutInternalHeaders(req), res);
    if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)) return core.shell(withoutInternalHeaders(req), res);
  }

  if (!isDeployment) session ??= staleSession;
  if (!session) {
    if (staleSession) return identityUnavailable(req, res);
    if (method === "GET" && wantsHtml(req)) {
      const returnTo = encodeURIComponent(`${pathname}${url.search}`);
      res.writeHead(302, { location: `/auth/login?returnTo=${returnTo}` });
      return void res.end();
    } else {
      return json(res, 401, { error: "sign in", loginUrl: "/auth/login" });
    }
  }

  if (method !== "GET" && method !== "HEAD" && !crossOrigin && !sameOriginRequest(req)) {
    return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
  }

  if (isDeployment) {
    const rest = pathname.slice(`/${seg}/`.length);
    const slash = rest.indexOf("/");
    const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const subPath = slash === -1 ? "/" : rest.slice(slash);
    if (!id) return json(res, 404, { error: "not_found" });
    return proxyToDeployment(req, res, {
      coreBase: CORE,
      id,
      subPath,
      search: url.search,
      principal: session.sub,
      signingSecret: CORE_SIGNING_SECRET,
      ...(PORTAL_IDENTITY_SECRET ? { identitySecret: PORTAL_IDENTITY_SECRET } : {}),
      ...(session.t ? { tenant: session.t } : {}),
    });
  }

  const settingsPath = pathname === "/settings" || pathname.startsWith("/settings/");
  if (method === "GET" && wantsHtml(req) && !settingsPath) {
    await surfaceConfigs.refresh(session.t, session.sub);
    if (surfaceConfigs.modelProviderConfigured(session.t) === false) {
      if (await isAdmin(session.sub, session.t)) {
        res.writeHead(302, { location: "/settings/onboarding", "cache-control": "no-store" });
        return void res.end();
      }
      return sendHtml(res, 503, notConfiguredHtml());
    }
  }

  const carried = storedSession(req);
  const named = carried && !carried.name && session.name ? { ...carried, name: session.name } : null;
  const handedOver = carried ? named : session;
  if (handedOver) {
    const others = (req.headers.cookie ?? "").split(";").map((part) => part.trim());
    req.headers.cookie = [
      ...others.filter((part) => part && !part.startsWith("portal_session=")),
      `portal_session=${encodeURIComponent(seal(handedOver, sessionKey))}`,
    ].join("; ");
  }
  if (core?.serves(method, pathname)) return core.handle(withoutInternalHeaders(req), res);
  return core ? core.shell(withoutInternalHeaders(req), res) : json(res, 404, { error: "not_found" });
}

function withoutInternalHeaders(req: IncomingMessage): IncomingMessage {
  for (const header of INTERNAL_HEADERS) delete req.headers[header];
  return req;
}

async function desktopLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  res.setHeader("cache-control", "no-store");
  if (!SESSION_SECRET || SESSION_SECRET.trim().length < 32 || !CORE_SIGNING_SECRET) {
    return json(res, 503, { error: "not_configured" });
  }
  if (url.pathname.endsWith("/redeem")) {
    if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
    if ((req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden" });
    let body: URLSearchParams;
    try {
      body = new URLSearchParams(await readBody(req, 12288));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
      throw error;
    }
    const claims = openDesktopLogin(
      body.get("code") ?? "",
      body.get("verifier") ?? "",
      body.get("state") ?? "",
      SESSION_SECRET,
      ORIGIN,
      ORG,
      SESSION_MAX_TTL_S,
    );
    if (!claims) return json(res, 400, { error: "invalid_desktop_login" });
    try {
      if (
        !(await claimOnce(
          coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal"),
          `desktop-login:${claims.jti}`,
          claims.expiresAtMs,
        ))
      ) {
        return json(res, 400, { error: "desktop_login_already_used" });
      }
    } catch (error) {
      if (error instanceof ClaimStoreUnavailableError) return json(res, 503, { error: "temporarily_unavailable" });
      throw error;
    }
    setSession(res, [
      ...sessionCookieSet(seal(claims.session, sessionKey), claims.session.sub),
      clearCookie("portal_impersonate", "/", SECURE_COOKIES),
    ]);
    return json(res, 200, { ok: true });
  }
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const challenge = url.searchParams.get("challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!desktopChallenge(challenge) || !desktopChallenge(state))
    return json(res, 400, { error: "invalid_desktop_request" });
  if (req.method === "POST" && !sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  const session = renewSessionCookie(req, res) ?? currentSession(req);
  if (!session) {
    res.writeHead(303, {
      location: `/auth/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      "cache-control": "no-store",
    });
    return void res.end();
  }
  if (req.method === "GET") {
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Open QM Desktop",
        heading: "Sign in to QM Desktop",
        icon: LOCK_ICON,
        msg: `Continue as ${session.sub}.`,
        actions: `<form method="post" action="${escapeHtml(`${url.pathname}${url.search}`)}"><button class="btn primary" type="submit">Open QM Desktop</button></form>`,
        help: "Only continue if you just started sign-in in the QM desktop app on this computer.",
      }),
    );
  }
  const callback = new URL("qm-desktop://auth/callback");
  callback.searchParams.set("code", mintDesktopLogin(session, SESSION_SECRET, ORIGIN, challenge, state));
  callback.searchParams.set("state", state);
  return sendHtml(
    res,
    200,
    cardPage({
      title: "Ready to open QM",
      heading: "Opening QM Desktop…",
      icon: LOCK_ICON,
      msg: "If QM doesn’t open automatically, use the button below.",
      actions: `<a id="desktop-launch" class="btn primary" href="${escapeHtml(callback.href)}">Open QM Desktop</a><script>${DESKTOP_LAUNCH_SCRIPT}</script>`,
      help: "This link expires in two minutes and works only for the app that requested it.",
    }),
    `${PAGE_CSP}; script-src '${DESKTOP_LAUNCH_SCRIPT_HASH}'`,
  );
}

async function inviteLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!SESSION_SECRET || !CORE_SIGNING_SECRET) return json(res, 503, { error: "not_configured" });
  if (req.method === "GET")
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Accept invitation",
        heading: "You're invited",
        icon: LOCK_ICON,
        msg: "",
        extra: '<p id="invite-status"></p><noscript>JavaScript is required to open this invitation.</noscript>',
        actions: `<form method="post" action="/auth/invite"><input id="invite-token" name="token" type="hidden"><button id="invite-confirm" class="btn primary" type="submit" disabled>Accept invitation</button></form><script>${INVITE_LOGIN_SCRIPT}</script>`,
        help: "",
      }),
      `${PAGE_CSP}; script-src '${INVITE_LOGIN_SCRIPT_HASH}'`,
    );
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  let token: string;
  try {
    token = new URLSearchParams(await readBody(req, 8192)).get("token") ?? "";
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
    throw error;
  }
  if (!token || token.length > 4096) return sendHtml(res, 400, signInErrorHtml("This invitation is invalid."));
  const path = withSourceAuthNonce("/v1/auth/invitations/redeem", CORE_SIGNING_SECRET);
  const body = JSON.stringify({ token });
  try {
    const r = await fetch(`${CORE}${path}`, {
      method: "POST",
      headers: signedHeaders(CORE_SIGNING_SECRET, "POST", path, body),
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok)
      return sendHtml(
        res,
        r.status >= 500 ? 503 : 400,
        signInErrorHtml(
          r.status >= 500
            ? "Sign-in is temporarily unavailable. Please try again."
            : "This invitation is expired, revoked, or already used. Ask your administrator for a new one.",
        ),
      );
    const data = (await r.json()) as { email: string };
    setAuthenticatedSession(res, data.email);
    res.writeHead(303, { location: "/", "cache-control": "no-store" });
    res.end();
  } catch {
    return sendHtml(res, 503, signInErrorHtml("Sign-in is temporarily unavailable. Please try again."));
  }
}

async function adminLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!SESSION_SECRET || SESSION_SECRET.trim().length < 32 || !CORE_SIGNING_SECRET) {
    return json(res, 503, { error: "not_configured" });
  }
  if (req.method === "GET") {
    return sendHtml(
      res,
      200,
      cardPage({
        title: "Admin sign-in",
        heading: "Sign in as an administrator",
        msg: "Only continue if you generated this link for your own admin account.",
        icon: LOCK_ICON,
        extra: '<p id="admin-email"></p><noscript>JavaScript is required to open this login link.</noscript>',
        actions: `<form method="post" action="/auth/admin-login"><input id="admin-token" name="token" type="hidden"><button id="admin-confirm" class="btn primary" style="width:100%" type="submit" disabled>Sign in</button></form><script>${ADMIN_LOGIN_SCRIPT}</script>`,
        help: "This link expires after five minutes and can be used once. Generate another with qm admin-login.",
      }),
      `${PAGE_CSP}; script-src '${ADMIN_LOGIN_SCRIPT_HASH}'`,
    );
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
  let token: string;
  try {
    token = new URLSearchParams(await readBody(req, 8192)).get("token") ?? "";
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return json(res, 413, { error: "payload_too_large" });
    throw error;
  }
  const claims = openAdminLogin(token, SESSION_SECRET, ORIGIN);
  const fail = () =>
    sendHtml(
      res,
      400,
      signInErrorHtml("This admin link is invalid, expired, or already used. Generate a new link with qm admin-login."),
    );
  if (!claims) return fail();
  const allowed = await adminProbeAttempt(claims.email);
  if (allowed === null)
    return sendHtml(res, 503, signInErrorHtml("Admin access could not be checked. Please try again."));
  if (!allowed) return sendHtml(res, 403, signInErrorHtml("This account does not have admin access."));
  try {
    const claimsStore = coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal");
    if (!(await claimOnce(claimsStore, `admin-login:${claims.jti}`, claims.expiresAtMs))) return fail();
  } catch (error) {
    if (error instanceof ClaimStoreUnavailableError) {
      return sendHtml(res, 503, signInErrorHtml("Sign-in is temporarily unavailable. Please try again."));
    }
    throw error;
  }
  setAuthenticatedSession(res, claims.email);
  res.writeHead(303, { location: "/settings/history", "cache-control": "no-store" });
  res.end();
}

async function trustedAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!trustedEntry) return json(res, 404, { error: "not_found" });
  if (url.pathname === "/auth/trusted/login") return trustedLogin(req, res, url, trustedEntry);
  if (url.pathname !== "/auth/trusted/callback") return json(res, 404, { error: "not_found" });
  setSession(res, [clearCookie("portal_trusted_tmp", "/auth/trusted", SECURE_COOKIES)]);
  try {
    const identity = await trustedEntry.finish(readCookie(req.headers.cookie, "portal_trusted_tmp"), url, workspaceFor);
    if (trustedAdminEnabled) {
      await provisionTrustedAdmin(
        {
          core: CORE,
          signingSecret: CORE_SIGNING_SECRET!,
          identitySecret: PORTAL_IDENTITY_SECRET!,
          org: ORG,
          issuer: trustedOidc!.issuer,
        },
        identity.subject,
      );
      adminCache.delete(identity.sub);
    }
    await tenantChoice.settleTrusted(req, res, identity);
  } catch (error) {
    console.warn(`[portal] trusted sign-in failed: ${errMessage(error)}`);
    sendHtml(
      res,
      400,
      signInErrorHtml("Trusted sign-in failed. Please start again from your provider.", "/auth/trusted/login"),
    );
  }
}

async function trustedLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  entry: NonNullable<typeof trustedEntry>,
): Promise<void> {
  const handle = url.searchParams.get("workspace");
  const workspace = handle === null ? undefined : await workspaceFor(handle);
  if (workspace === null) return sendHtml(res, 404, signInErrorHtml("unknown workspace"));
  const pending = openTmp(readCookie(req.headers.cookie, "portal_oidc_tmp"), tmpKey, Date.now())?.returnTo;
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo") ?? pending ?? null, PUBLIC_URL, APPS_DOMAIN);
  const existing = currentSession(req);
  const trustedPrefix = `oidc:${createHash("sha256").update(trustedOidc!.issuer).digest("hex")}:`;
  const signedIn = existing && !existing.appOnly && existing.sub.startsWith(trustedPrefix);
  if (signedIn && (!workspace || existing.t === workspace.tenant)) {
    res.writeHead(302, { location: returnTo, "cache-control": "no-store" });
    return void res.end();
  }
  const login = entry.start(returnTo, handle && workspace ? { handle, ...workspace } : undefined);
  setSession(res, [
    setCookie("portal_trusted_tmp", login.cookie, { path: "/auth/trusted", maxAge: login.ttl, secure: SECURE_COOKIES }),
  ]);
  res.writeHead(302, { location: login.location, "cache-control": "no-store" });
  res.end();
}

const tenantChoice = createTenantChoice({
  core: CORE,
  signingSecret: CORE_SIGNING_SECRET,
  key: tmpKey,
  ttlS: TMP_TTL_S,
  secureCookies: SECURE_COOKIES,
  lockIcon: LOCK_ICON,
  sameOrigin: sameOriginRequest,
  pin: (returnTo) => appHandoff.pin(returnTo),
  cardPage,
  signInErrorHtml,
  noWorkspaceHtml,
  sendHtml: (res, status, html, scriptHash) =>
    sendHtml(res, status, html, scriptHash ? `${PAGE_CSP}; script-src '${scriptHash}'` : PAGE_CSP),
  finishSignIn,
  finishTrustedSignIn,
});

function setAuthenticatedSession(
  res: ServerResponse,
  sub: string,
  name = "",
  appOnly = false,
  tenant?: string,
  domainWide = true,
): void {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = {
    k: "session",
    sub,
    org: ORG,
    auth: now,
    iat: now,
    exp: now + SESSION_TTL_S,
    ...(name ? { name } : {}),
    ...(appOnly ? { appOnly: true } : {}),
    ...(tenant ? { t: tenant } : {}),
  };
  setSession(res, [
    ...sessionCookieSet(seal(session, sessionKey), session.sub, domainWide),
    clearCookie("portal_trusted_tmp", "/auth/trusted", SECURE_COOKIES),
    clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
    clearCookie("portal_tenant_choice", "/auth", SECURE_COOKIES),
    clearCookie("portal_impersonate", "/", SECURE_COOKIES),
  ]);
}

function authLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (
    trustedOidc &&
    trustedSignInLabel &&
    url.searchParams.get("provider") !== "primary" &&
    readCookie(req.headers.cookie, "portal_login_provider") ===
      createHash("sha256").update(trustedOidc.issuer).digest("hex")
  ) {
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), PUBLIC_URL, APPS_DOMAIN);
    res.writeHead(302, {
      location: `/auth/trusted/login?returnTo=${encodeURIComponent(returnTo)}`,
      "cache-control": "no-store",
    });
    return void res.end();
  }
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), PUBLIC_URL, APPS_DOMAIN);
  const localSession = localDevSession(req, Date.now(), true);
  if (localSession) {
    setSession(res, [
      ...sessionCookieSet(seal(localSession, sessionKey), localSession.sub),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(AUTH_BROKER_UPSTREAM ? [clearCookie("qm_idp_session", AUTH_BROKER_PREFIX, true)] : []),
      clearCookie(LOCAL_LOGOUT_COOKIE, "/", SECURE_COOKIES),
    ]);
    res.writeHead(302, { location: returnTo, "cache-control": "no-store" });
    return void res.end();
  }
  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = pkcePair();
  const now = Math.floor(Date.now() / 1000);
  const tmp: TmpClaims = { k: "tmp", state, nonce, pkceVerifier: verifier, returnTo, iat: now, exp: now + TMP_TTL_S };
  setSession(res, [
    setCookie("portal_oidc_tmp", seal(tmp, tmpKey), { path: "/auth", maxAge: TMP_TTL_S, secure: SECURE_COOKIES }),
  ]);
  res.writeHead(302, { location: buildAuthorizeUrl(OIDC, { state, nonce, challenge }), "cache-control": "no-store" });
  res.end();
}

async function authCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const fail = (detail: string): void => {
    setSession(res, [clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES)]);
    sendHtml(res, 400, signInErrorHtml(detail));
  };

  if (url.searchParams.get("error")) return fail(`identity provider returned: ${url.searchParams.get("error") ?? ""}`);
  const code = url.searchParams.get("code") ?? "";
  const stateParam = url.searchParams.get("state") ?? "";

  const tmp = openTmp(readCookie(req.headers.cookie, "portal_oidc_tmp"), tmpKey, Date.now());
  if (!tmp) return fail("login session expired, please try again");
  if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail("invalid login state");
  if (!consumeState(tmp.state)) return fail("login already used, please try again");

  let signIn: VerifiedSignIn;
  let tenants: SignInTenant[] = [];
  try {
    const { accessToken, idToken } = await exchangeCode(OIDC, { code, codeVerifier: tmp.pkceVerifier });
    const claims = await verifyIdToken(OIDC, idToken, tmp.nonce);
    if (OIDC.expectedTeamId) {
      const team = claims["https://slack.com/team_id"];
      if (team !== OIDC.expectedTeamId) throw new Error("workspace not permitted");
    }
    const info = await fetchUserinfo(OIDC, accessToken);
    const infoSub = typeof info.sub === "string" ? info.sub : "";
    if (!infoSub) throw new Error("userinfo missing sub");
    if (typeof claims.sub === "string" && claims.sub !== infoSub) throw new Error("subject mismatch");
    const rawName = info.name ?? claims.name;
    signIn = {
      sub: infoSub,
      name: typeof rawName === "string" ? rawName.trim().slice(0, 200) : "",
      claims,
      userinfo: info,
    };
    const email = verifiedEmail(info);
    if (email) tenants = (await coreEmailTenants(CORE, CORE_SIGNING_SECRET, email)).tenants;
  } catch (e) {
    return fail(errMessage(e, "sign-in failed"));
  }
  return tenantChoice.settle(
    res,
    { signIn },
    tmp.returnTo,
    tenants,
    await appHandoff.pin(tmp.returnTo),
    req,
    verifiedEmail(signIn.userinfo),
  );
}

async function finishTrustedSignIn(
  res: ServerResponse,
  who: TrustedSignIn,
  returnTo: string,
  tenant?: string,
): Promise<void> {
  await signedInNames.record(who.sub, who.name, tenant);
  setAuthenticatedSession(res, who.sub, who.name, false, tenant);
  res.writeHead(302, { location: sanitizeReturnTo(returnTo, PUBLIC_URL, APPS_DOMAIN), "cache-control": "no-store" });
  res.end();
}

async function finishSignIn(
  res: ServerResponse,
  { sub, name, claims, userinfo }: VerifiedSignIn,
  returnTo: string,
  tenant: string | undefined,
): Promise<void> {
  let principal: { sub: string; appOnly?: true };
  try {
    principal = await resolvePrincipal(PRINCIPAL_RULE, { sub, claims, userinfo }, (email) =>
      coreEmailAdmission(CORE, CORE_SIGNING_SECRET, email, "portal", portalIdentityHeaders(email, tenant)),
    );
  } catch (e) {
    setSession(res, [
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      clearCookie("portal_tenant_choice", "/auth", SECURE_COOKIES),
    ]);
    if (e instanceof AdmissionRefusedError && tenant === undefined) {
      const email = verifiedEmail(userinfo);
      const shared = email
        ? (await coreEmailTenants(CORE, CORE_SIGNING_SECRET, email).catch(() => null))?.shared
        : false;
      if (shared) return sendHtml(res, 403, noWorkspaceHtml(email));
    }
    return sendHtml(res, 400, signInErrorHtml(errMessage(e, "sign-in failed")));
  }
  if (!principal.appOnly) await signedInNames.record(principal.sub, name, tenant);
  setAuthenticatedSession(res, principal.sub, name, principal.appOnly, tenant);
  res.writeHead(302, {
    location: sanitizeReturnTo(returnTo, PUBLIC_URL, APPS_DOMAIN),
    "cache-control": "no-store",
  });
  res.end();
}

export function bootChecks(): void {
  const problems: string[] = [...API_ALLOWED_ORIGINS.problems];
  for (const origin of API_ALLOWED_ORIGINS.origins) {
    const host = hostOf(origin);
    if (IS_PROD && !origin.startsWith("https://")) {
      problems.push(`PORTAL_API_ALLOWED_ORIGINS entry "${origin}" must use https in production`);
    }
    if (APPS_DOMAIN && hostIsWithinDomain(host, APPS_DOMAIN)) {
      problems.push(
        `PORTAL_API_ALLOWED_ORIGINS entry "${origin}" is under the apps domain (${APPS_DOMAIN}), which serves user-deployed apps`,
      );
    }
    if (origin === ORIGIN) problems.push(`PORTAL_API_ALLOWED_ORIGINS must not list the portal's own origin`);
  }
  if (!AUTH_BROKER_UPSTREAM && originOf(OIDC.authEndpoint) && originOf(OIDC.authEndpoint) === originOf(PUBLIC_URL)) {
    problems.push(
      "OIDC_AUTH_ENDPOINT is on the portal's own origin but AUTH_BROKER_UPSTREAM is unset — every sign-in would redirect from /auth/login back into the portal forever; wire AUTH_BROKER_UPSTREAM to the auth service or point OIDC_AUTH_ENDPOINT at a real identity provider",
    );
  }
  if (LOCAL_AUTH_BYPASS_REQUESTED && IS_PROD) {
    problems.push("PORTAL_LOCAL_AUTH_BYPASS may not be enabled in production");
  }
  if (LOCAL_AUTH_BYPASS_REQUESTED && !isLoopbackUrl(PUBLIC_URL)) {
    problems.push("PORTAL_LOCAL_AUTH_BYPASS requires a localhost, 127.0.0.1, or ::1 PUBLIC_WEB_URL");
  }

  if (COOKIE_DOMAIN && !hostIsWithinDomain(hostOf(PUBLIC_URL), COOKIE_DOMAIN)) {
    problems.push(`PORTAL_COOKIE_DOMAIN (${COOKIE_DOMAIN}) must cover PUBLIC_WEB_URL's host`);
  }
  if (APPS_DOMAIN && COOKIE_DOMAIN && !hostIsWithinDomain(APPS_DOMAIN, COOKIE_DOMAIN)) {
    problems.push(`PORTAL_COOKIE_DOMAIN (${COOKIE_DOMAIN}) must cover PORTAL_APPS_DOMAIN (${APPS_DOMAIN})`);
  }
  if (PRINCIPAL_RULE.claim !== "sub" && PRINCIPAL_RULE.claim !== "email") {
    problems.push(`OIDC_PRINCIPAL_CLAIM must be "sub" or "email" (got "${PRINCIPAL_RULE.claim}")`);
  }
  if (
    !Number.isFinite(SESSION_TTL_S) ||
    SESSION_TTL_S <= 0 ||
    !Number.isFinite(SESSION_MAX_TTL_S) ||
    SESSION_MAX_TTL_S < SESSION_TTL_S
  ) {
    problems.push("PORTAL_SESSION_MAX_TTL_S must be a finite number at least as large as PORTAL_SESSION_TTL_S");
  }
  if ((PRINCIPAL_RULE.allowedEmailDomain || PRINCIPAL_RULE.allowedEmails?.length) && PRINCIPAL_RULE.claim !== "email") {
    problems.push("OIDC_ALLOWED_EMAIL_DOMAIN and OIDC_ALLOWED_EMAILS require OIDC_PRINCIPAL_CLAIM=email");
  }
  if (IS_PROD) {
    if (isMissingOrPlaceholder(SESSION_SECRET))
      problems.push("PORTAL_SESSION_SECRET is required and may not be a placeholder in production");
    if (isMissingOrPlaceholder(CORE_SIGNING_SECRET))
      problems.push("CORE_SIGNING_SECRET is required and may not be a placeholder in production");
    if (isMissingOrPlaceholder(OIDC.clientId))
      problems.push("OIDC_CLIENT_ID is required and may not be a placeholder in production");
    if (isMissingOrPlaceholder(OIDC.clientSecret))
      problems.push("OIDC_CLIENT_SECRET is required and may not be a placeholder in production");
    if (
      PRINCIPAL_RULE.allowedEmailDomain &&
      (isMissingOrPlaceholder(PRINCIPAL_RULE.allowedEmailDomain) ||
        !validEmailDomain(PRINCIPAL_RULE.allowedEmailDomain))
    ) {
      problems.push("OIDC_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set");
    }
    if (
      PRINCIPAL_RULE.allowedEmails?.some(
        (email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || isMissingOrPlaceholder(email),
      )
    ) {
      problems.push("OIDC_ALLOWED_EMAILS must be a comma-separated list of valid, non-placeholder email addresses");
    }
    if (
      !PRINCIPAL_RULE.allowedEmailDomain &&
      !PRINCIPAL_RULE.allowedEmails?.length &&
      isMissingOrPlaceholder(OIDC.expectedTeamId)
    ) {
      problems.push(
        "production requires OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_EMAIL_DOMAIN, or PORTAL_EXPECTED_TEAM_ID as an identity-provider trust boundary",
      );
    }
    if (OIDC.expectedTeamId !== undefined && isMissingOrPlaceholder(OIDC.expectedTeamId)) {
      problems.push("PORTAL_EXPECTED_TEAM_ID is optional, but may not be a placeholder when configured");
    }
    if (!isSlackIssuer(OIDC.issuer) && !OIDC_JWKS_CONFIGURED) {
      problems.push("OIDC_JWKS_URI is required for a non-Slack issuer");
    }
    if (SESSION_SECRET && CORE_SIGNING_SECRET && SESSION_SECRET === CORE_SIGNING_SECRET) {
      problems.push("PORTAL_SESSION_SECRET must differ from CORE_SIGNING_SECRET");
    }
    if (!isSecureOrLoopbackUrl(PUBLIC_URL))
      problems.push("PUBLIC_WEB_URL must be https in production unless it is a loopback address");
    if (!isSecureOrLoopbackUrl(OIDC.authEndpoint)) {
      problems.push(
        `OIDC_AUTH_ENDPOINT must be https unless it is a loopback address, since the browser is sent there: ${OIDC.authEndpoint}`,
      );
    }
    const brokerOrigin =
      AUTH_BROKER_UPSTREAM && isPrivateNetworkUrl(AUTH_BROKER_UPSTREAM) ? originOf(AUTH_BROKER_UPSTREAM) : "";
    for (const ep of [OIDC.tokenEndpoint, OIDC.userinfoEndpoint, OIDC.jwksUri]) {
      if (!ep.startsWith("https://") && !(brokerOrigin && originOf(ep) === brokerOrigin)) {
        problems.push(`OIDC endpoint must be https unless it is the built-in broker on the private network: ${ep}`);
      }
    }
    if (AUTH_BROKER_UPSTREAM) {
      if (!isPrivateNetworkUrl(AUTH_BROKER_UPSTREAM)) {
        problems.push(
          "AUTH_BROKER_UPSTREAM must address a private-network host, since the broker is never exposed directly",
        );
      }
      if (OIDC.issuer !== `${PUBLIC_URL}${AUTH_BROKER_PREFIX}`) {
        problems.push(`OIDC_ISSUER must be ${PUBLIC_URL}${AUTH_BROKER_PREFIX} when the built-in broker is wired`);
      }
      if (OIDC.authEndpoint !== `${PUBLIC_URL}${AUTH_BROKER_PREFIX}/authorize`) {
        problems.push(
          `OIDC_AUTH_ENDPOINT must be ${PUBLIC_URL}${AUTH_BROKER_PREFIX}/authorize when the built-in broker is wired`,
        );
      }
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`[portal] FATAL: ${p}`);
    throw new Error(`portal refusing to start: ${problems.length} misconfiguration(s)`);
  }
}

function validEmailDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export async function startServer(options: { port: number; host?: string; core?: CoreHandoff }): Promise<void> {
  bootChecks();
  core = options.core;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  if (process.env.AUTH_EMBEDDED === "1") {
    if (AUTH_BROKER_UPSTREAM !== "http://127.0.0.1:8099") {
      throw new Error("Embedded auth requires the loopback broker upstream");
    }
    const auth = await import("../../auth/src/index.ts");
    const broker = await auth.startServer({
      port: 8099,
      host: "127.0.0.1",
      ...(trustedSignInLabel ? { trustedSignInLabel } : {}),
    });
    server.once("close", () => broker.close());
    server.once("error", () => broker.close());
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
      console.log(`[portal] public front door on http://localhost:${options.port} (org ${ORG})`);
      if (!SESSION_SECRET)
        console.warn("[portal] PORTAL_SESSION_SECRET unset, using an INSECURE dev key (dev/test only)");
      if (!SECURE_COOKIES) console.warn("[portal] PUBLIC_WEB_URL is not https, cookies are NOT Secure (dev/test only)");
      if (LOCAL_AUTH_BYPASS)
        console.warn(
          `[portal] PORTAL_LOCAL_AUTH_BYPASS=1 -- using ${LOCAL_AUTH_PRINCIPAL} as the local session principal (dev/test only)`,
        );
    });
  });
}

export { handle, server };
