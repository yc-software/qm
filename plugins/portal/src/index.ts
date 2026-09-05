import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ADMIN_LOGIN_SCRIPT, ADMIN_LOGIN_SCRIPT_HASH, openAdminLogin } from "./admin-login.ts";
import { LRUCache } from "lru-cache";
import {
  deriveKey,
  seal,
  openSession,
  openImpersonation,
  openTmp,
  setCookie,
  clearCookie,
  readCookie,
  randomToken,
  safeEqual,
  sanitizeReturnTo,
  type SessionClaims,
  type ImpersonationClaims,
  type TmpClaims,
} from "./session.ts";
import {
  pkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserinfo,
  resolvePrincipal,
  verifyIdToken,
  type OidcConfig,
  type PrincipalRule,
} from "./oidc.ts";
import {
  proxyToSurface,
  proxyToDeployment,
  proxyToUpstream,
  FORWARD_AGENT_API_HEADERS,
  FORWARD_DEPLOYMENT_LAYER_HEADERS,
  FORWARD_OAUTH_HEADERS,
  FORWARD_BROKER_HEADERS,
  FORWARD_WEBHOOK_HEADERS,
} from "./proxy.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { coreClaimStore, claimOnce, withinRateLimit, ClaimStoreUnavailableError } from "../../chassis/src/claims.ts";
import { coreEmailAllowed } from "../../chassis/src/external-members.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { json, escapeHtml, serveEmojiFavicon, readBody, PayloadTooLargeError } from "../../chassis/src/http.ts";
import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
  portFromEnv,
} from "../../chassis/src/env.ts";

const PORT = portFromEnv(8097);
const PUBLIC_URL = (process.env.PORTAL_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const SESSION_SECRET = process.env.PORTAL_SESSION_SECRET;
const SESSION_TTL_S = Number(process.env.PORTAL_SESSION_TTL_S ?? 28800);
const SESSION_MAX_TTL_S = Number(process.env.PORTAL_SESSION_MAX_TTL_S ?? Math.max(86400, SESSION_TTL_S));
const SESSION_RENEW_AFTER_S = Math.floor(SESSION_TTL_S / 2);
const APPS_DOMAIN = process.env.PORTAL_APPS_DOMAIN || process.env.DEPLOY_APPS_DOMAIN || undefined;
const COOKIE_DOMAIN =
  process.env.PORTAL_COOKIE_DOMAIN ||
  (APPS_DOMAIN ? derivedCookieDomain(hostOf(process.env.PORTAL_PUBLIC_URL ?? ""), APPS_DOMAIN) : undefined);
const IS_PROD = process.env.NODE_ENV === "production";
const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");
const ORIGIN = (() => {
  try {
    return new URL(PUBLIC_URL).origin;
  } catch {
    return "";
  }
})();
const LOCAL_AUTH_BYPASS_REQUESTED = process.env.PORTAL_LOCAL_AUTH_BYPASS === "1";
const LOCAL_AUTH_BYPASS = LOCAL_AUTH_BYPASS_REQUESTED && !IS_PROD && isLocalPortalUrl(PUBLIC_URL);
const LOCAL_AUTH_PRINCIPAL = process.env.PORTAL_DEV_PRINCIPAL || process.env.USER || "dev-admin";
const PLAYGROUND = process.env.PORTAL_PLAYGROUND === "1";
const DEPLOYMENTS_ENABLED = process.env.PORTAL_DEPLOYMENTS_ENABLED
  ? process.env.PORTAL_DEPLOYMENTS_ENABLED === "1"
  : !PLAYGROUND;
function playgroundIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}
const PLAYGROUND_MINTS_PER_IP = playgroundIntEnv("PORTAL_PLAYGROUND_MINTS_PER_IP", 30);
const PLAYGROUND_MINT_WINDOW_S = playgroundIntEnv("PORTAL_PLAYGROUND_MINT_WINDOW_S", 3600);
const NEUTRAL_ACCENT = "#4f46e5";
let brandAccent = NEUTRAL_ACCENT;
let modelProviderConfigured: boolean | undefined;
let surfaceConfigNextAt = 0;
let surfaceConfigInflight: Promise<void> | null = null;
function refreshSurfaceConfig(): Promise<void> {
  if (Date.now() >= surfaceConfigNextAt) {
    surfaceConfigNextAt = Date.now() + 5_000;
    surfaceConfigInflight = fetchSurfaceConfig().finally(() => {
      surfaceConfigInflight = null;
    });
  }
  return surfaceConfigInflight ?? Promise.resolve();
}
async function fetchSurfaceConfig(): Promise<void> {
  try {
    const path = withSourceAuthNonce("/v1/surface-config", CORE_SIGNING_SECRET);
    const r = await fetch(`${CORE}${path}`, {
      headers: signedHeaders(CORE_SIGNING_SECRET, "GET", path),
      signal: AbortSignal.timeout(2_000),
    });
    if (r.ok) {
      const body = (await r.json()) as { branding?: { accent?: unknown }; modelProviderConfigured?: unknown };
      brandAccent = typeof body.branding?.accent === "string" ? body.branding.accent : NEUTRAL_ACCENT;
      modelProviderConfigured =
        typeof body.modelProviderConfigured === "boolean" ? body.modelProviderConfigured : undefined;
      surfaceConfigNextAt = Date.now() + (modelProviderConfigured === false ? 5_000 : 30_000);
    }
  } catch {
    void 0;
  }
}

const UPSTREAMS: Record<string, string> = {
  "web-ui": (process.env.WEB_UI_UPSTREAM ?? "http://localhost:8096").replace(/\/$/, ""),
  admin: (process.env.ADMIN_UPSTREAM ?? "http://localhost:8090").replace(/\/$/, ""),
};
const COOKIE_FOR: Record<string, string> = { "web-ui": "webuiuser", admin: "admin" };

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
const IMPERSONATE_TTL_S = Number(process.env.PORTAL_IMPERSONATE_TTL_S ?? 3600);

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
const adminCache = new LRUCache<string, boolean>({ max: 10_000, ttl: ADMIN_TTL_MS });

async function adminProbeAttempt(sub: string): Promise<boolean | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ADMIN_PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { cookie: `admin=${encodeURIComponent(sub)}` };
    if (PORTAL_IDENTITY_SECRET) {
      headers[PORTAL_IDENTITY_HEADER] = mintPortalIdentity(
        { p: sub, exp: Date.now() + 60_000 },
        PORTAL_IDENTITY_SECRET,
      );
    }
    const r = await fetch(`${UPSTREAMS.admin}/api/whoami`, { headers, signal: ctrl.signal });
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

async function adminProbe(sub: string): Promise<{ isAdmin: boolean; failed: boolean }> {
  const hit = adminCache.get(sub);
  if (hit !== undefined) return { isAdmin: hit, failed: false };
  for (let attempt = 0; attempt < ADMIN_PROBE_ATTEMPTS; attempt++) {
    const isAdmin = await adminProbeAttempt(sub);
    if (isAdmin === null) {
      if (attempt + 1 < ADMIN_PROBE_ATTEMPTS)
        await new Promise((resolve) => setTimeout(resolve, ADMIN_PROBE_RETRY_DELAY_MS));
      continue;
    }
    adminCache.set(sub, isAdmin);
    return { isAdmin, failed: false };
  }
  return { isAdmin: false, failed: true };
}

async function isAdmin(sub: string): Promise<boolean> {
  return (await adminProbe(sub)).isAdmin;
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function sendHtml(res: ServerResponse, status: number, html: string, csp = PAGE_CSP): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const originMatches =
    typeof origin === "string" &&
    (() => {
      try {
        return new URL(origin).origin === ORIGIN;
      } catch {
        return false;
      }
    })();
  const site = req.headers["sec-fetch-site"];
  if (typeof site !== "string") return originMatches;
  return site === "same-origin" && (originMatches || origin === undefined || origin === "null");
}

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

function isLocalPortalUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
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
  return (
    openSession(readCookie(req.headers.cookie, "portal_session"), sessionKey, Date.now(), ORG, SESSION_MAX_TTL_S) ??
    localDevSession(req)
  );
}

const CARD_STYLE = `<style>
  :root{
    --bg:#ffffff; --surface:#ffffff; --text:#0a0a0a; --muted:#737373;
    --border:#e5e5e5; --secondary:#f5f5f5; --warn:#b42318; --warn-bg:#fdeceb;
    --shadow:0 1px 3px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.05);
    --radius-md:10px; --radius-lg:16px;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0a0a0a; --surface:#171717; --text:#fafafa; --muted:#a3a3a3;
      --border:#2a2a2a; --secondary:#262626; --warn:#ff8a80; --warn-bg:#2a1a1a;
      --shadow:0 1px 3px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.4); }
  }
  *{ box-sizing:border-box; }
  html,body{ height:100%; }
  body{
    margin:0; background:var(--bg); color:var(--text); display:flex; min-height:100%;
    font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  main{ margin:auto; padding:32px 20px; width:100%; display:grid; place-items:center; }
  .card{
    width:100%; max-width:420px; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); box-shadow:var(--shadow); padding:34px 32px 30px; text-align:center;
  }
  .card.wide{ max-width:440px; }
  .icon{ width:52px; height:52px; margin:0 auto 18px; border-radius:var(--radius-md); background:var(--secondary);
    display:grid; place-items:center; }
  .icon svg{ width:26px; height:26px; stroke:var(--text); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn{ background:var(--warn-bg); }
  .icon.warn svg{ stroke:var(--warn); stroke-width:2; }
  h1{ font-size:20px; font-weight:600; letter-spacing:0; margin:0 0 8px; }
  .msg{ color:var(--muted); margin:0 auto 8px; max-width:40ch; font-size:14px; }
  .reason{ margin:16px auto 26px; font-size:13px; color:var(--text);
    background:var(--warn-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px;
    text-align:left; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .note{ margin:18px auto 26px; font-size:13px; color:var(--text); background:var(--secondary);
    border:1px solid var(--border); border-radius:var(--radius-md); padding:12px 14px; text-align:left; }
  .note .who{ display:flex; align-items:center; gap:8px; color:var(--muted); }
  .note .who b{ color:var(--text); }
  .note p{ margin:8px 0 0; color:var(--muted); }
  .actions{ display:grid; gap:10px; }
  .btn{ display:flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px;
    text-decoration:none; font-weight:600; font-size:14px; border-radius:var(--radius-md); cursor:pointer;
    transition:opacity .12s ease, background .12s ease, color .12s ease; }
  .btn.primary{ background:var(--text); color:var(--bg); border:1px solid var(--text); }
  .btn.primary:hover{ opacity:.9; }
  .btn.ghost{ background:none; color:var(--muted); border:1px solid var(--border); }
  .btn.ghost:hover{ background:var(--secondary); color:var(--text); }
  .btn:focus-visible{ outline:2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset:2px; }
  .help{ color:var(--muted); font-size:12.5px; margin:20px 0 0; }
  @media (prefers-reduced-motion:reduce){ *{ transition:none !important; } }
</style>`;

const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

function cardPage(o: {
  title: string;
  heading: string;
  msg: string;
  icon: string;
  warn?: boolean;
  wide?: boolean;
  extra?: string;
  actions: string;
  help: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · Portal</title>
${CARD_STYLE}
</head>
<body>
  <main>
    <section class="card${o.wide ? " wide" : ""}" aria-labelledby="t">
      <div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">
        ${o.icon}
      </div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      <p class="msg">${escapeHtml(o.msg)}</p>
      ${o.extra ?? ""}
      <div class="actions">
        ${o.actions}
      </div>
      <p class="help">${escapeHtml(o.help)}</p>
    </section>
  </main>
</body>
</html>`;
}

export function signInErrorHtml(detail: string): string {
  return cardPage({
    title: "Sign-in failed",
    heading: "We couldn't sign you in",
    msg: "Your sign-in didn't complete. This is usually temporary — trying again resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    extra: `<p class="reason"><strong>Details</strong>${escapeHtml(detail)}</p>`,
    actions: `<a class="btn primary" href="/auth/login">Try signing in again</a>
        <a class="btn ghost" href="/">Back to start</a>`,
    help: "Still stuck? Make sure you're a member of the approved workspace, then contact your admin.",
  });
}

export function nonAdminDeniedHtml(o: { sub: string; org: string }): string {
  return cardPage({
    title: "No admin access",
    heading: "You don't have admin access",
    msg: "The Admin area is limited to governance admins. Your account is signed in and verified — it just isn't granted admin rights.",
    icon: LOCK_ICON,
    wide: true,
    extra: `<div class="note">
        <span class="who">Signed in as <b>${escapeHtml(o.sub)}</b> &middot; ${escapeHtml(o.org)}</span>
        <p>Admin rights come from your organization's admin grants. If you need access, ask an existing admin to grant it.</p>
      </div>`,
    actions: `<a class="btn primary" href="/">Back to your surfaces</a>
        <a class="btn ghost" href="/admin/">Try again</a>
        <a class="btn ghost" href="/">Open the assistant instead</a>`,
    help: "You can keep using every surface available to your account.",
  });
}

export function notConfiguredHtml(): string {
  return cardPage({
    title: "Not set up yet",
    heading: "This deployment isn't set up yet",
    msg: "An admin still needs to finish setup by adding a model API key. Until then the assistant can't answer.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/">Try again</a>`,
    help: "Ask your admin to complete onboarding in the Admin area.",
  });
}

export function adminUnavailableHtml(): string {
  return cardPage({
    title: "Admin temporarily unavailable",
    heading: "Admin is temporarily unavailable",
    msg: "We couldn't check your admin access right now. This is usually temporary — trying again resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/admin/">Try again</a>
        <a class="btn ghost" href="/">Back to your surfaces</a>`,
    help: "If this keeps happening, the admin service may be down — contact your admin.",
  });
}

const connectStyle = (): string => `<style>
  :root{ --bg:#0a0a0a; --text:#fafafa; --muted:#a3a3a3; --border:#2a2a2a; --brand:${brandAccent}; --radius-md:10px; }
  html,body{ height:100%; margin:0; }
  body{ background:var(--bg); color:var(--text); display:grid; place-items:center; padding:40px 20px;
    font:14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  .card{ max-width:440px; text-align:center; }
  h1{ font-size:19px; margin:0 0 10px; }
  p{ color:var(--muted); margin:0 0 18px; }
  .btn{ display:inline-block; font-weight:600; min-height:40px; line-height:40px; padding:0 18px;
    border:1px solid var(--brand); border-radius:var(--radius-md); background:var(--brand); color:#fff; text-decoration:none; }
  a.muted{ color:var(--muted); display:inline-block; margin-top:14px; }
</style>`;

function connectPage(o: { title: string; body: string; action?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(o.title)} · Portal</title>${connectStyle()}</head>
<body><div class="card"><h1>${escapeHtml(o.title)}</h1><p>${escapeHtml(o.body)}</p>${o.action ?? ""}</div></body></html>`;
}

function providerLabel(provider: string): string {
  if (provider === "google") return "Google";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "this app";
}

export function connectErrorHtml(detail: string): string {
  return connectPage({ title: "Can't connect", body: detail });
}

export function connectWrongRecipientHtml(o: { provider: string; alreadyConnected: boolean }): string {
  const prov = providerLabel(o.provider);
  if (o.alreadyConnected) {
    return connectPage({
      title: `You've already connected ${prov}`,
      body: `This link was meant for a different teammate, and your ${prov} is already connected — there's nothing to do here.`,
      action: `<a class="muted" href="/connectors">Manage your connections</a>`,
    });
  }
  return connectPage({
    title: "This link was for someone else",
    body: `This connect link was created for a different teammate. Want to connect your own ${prov} instead?`,
    action: `<a class="btn" href="/connect/${encodeURIComponent(o.provider)}/self-connect">Connect my ${escapeHtml(prov)}</a>`,
  });
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
  };
  let data: { status?: string; authorizeUrl?: string; provider?: string; clickerConnected?: boolean };
  try {
    const r = await fetch(`${CORE}${path}`, { headers });
    data = (await r.json().catch(() => ({}))) as typeof data;
  } catch {
    return sendHtml(
      res,
      502,
      connectErrorHtml("We couldn't reach the connection service. Please try the link again in a moment."),
    );
  }
  switch (data.status) {
    case "authorize":
      if (!data.authorizeUrl)
        return sendHtml(res, 502, connectErrorHtml("The connection service returned an unexpected response."));
      res.writeHead(302, { location: data.authorizeUrl, "cache-control": "no-store" });
      return void res.end();
    case "wrong_recipient":
      return sendHtml(
        res,
        200,
        connectWrongRecipientHtml({ provider: data.provider ?? "", alreadyConnected: !!data.clickerConnected }),
      );
    case "expired":
      return sendHtml(res, 200, connectErrorHtml("This connect link has expired — ask the agent for a fresh one."));
    default:
      return sendHtml(
        res,
        200,
        connectErrorHtml("This connect link is invalid or was already used — ask the agent for a fresh one."),
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
        message: "couldn't reach the credential service — try again in a moment",
      });
    return sendHtml(
      res,
      502,
      '<!doctype html><meta charset=utf-8><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h2>Service unavailable</h2><p>Try the link again in a moment.</p></body>',
    );
  }
  const bodyText = await r.text();
  const ct = r.headers.get("content-type") ?? (isPost ? "application/json" : "text/html; charset=utf-8");
  res.writeHead(r.status, { "content-type": ct, "cache-control": "no-store" });
  return void res.end(bodyText);
}

async function handleSelfConnect(res: ServerResponse, o: { provider: string; session: SessionClaims }): Promise<void> {
  const redirectUri = `${PUBLIC_URL}/v1/connectors/oauth/${encodeURIComponent(o.provider)}/callback`;
  const qs = new URLSearchParams({ principalId: o.session.sub, redirectUri, returnTo: "/connectors" });
  const path = withSourceAuthNonce(
    `/v1/connectors/oauth/${encodeURIComponent(o.provider)}/start?${qs.toString()}`,
    CORE_SIGNING_SECRET,
  );
  try {
    const r = await fetch(`${CORE}${path}`, { headers: signedHeaders(CORE_SIGNING_SECRET, "GET", path) });
    const data = (await r.json().catch(() => ({}))) as { authorizeUrl?: string; message?: string };
    if (data.authorizeUrl) {
      res.writeHead(302, { location: data.authorizeUrl, "cache-control": "no-store" });
      return void res.end();
    }
    return sendHtml(
      res,
      200,
      connectErrorHtml(data.message ?? "We couldn't start the connection. This app may not be configured."),
    );
  } catch {
    return sendHtml(
      res,
      502,
      connectErrorHtml("We couldn't reach the connection service. Please try again in a moment."),
    );
  }
}

async function coreImpersonate(
  action: "start" | "stop",
  admin: string,
  target: string,
): Promise<{ ok: boolean; status: number; displayName?: string; message?: string }> {
  const path = withSourceAuthNonce(`/v1/admin/impersonate${action === "stop" ? "/stop" : ""}`, CORE_SIGNING_SECRET);
  const body = JSON.stringify({ target });
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, "POST", path, body),
    "x-admin-actor": `${admin}@${ORG}`,
    ...(PORTAL_IDENTITY_SECRET
      ? { [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: admin, exp: Date.now() + 60_000 }, PORTAL_IDENTITY_SECRET) }
      : {}),
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

function isDeploymentLayerPassthrough(method: string, pathname: string): boolean {
  return (method === "GET" || method === "PUT") && pathname === "/v1/deployment-layer";
}

function sessionCookieSet(value: string): string[] {
  const set = setCookie("portal_session", value, {
    path: "/",
    maxAge: SESSION_TTL_S,
    secure: SECURE_COOKIES,
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  });
  return COOKIE_DOMAIN ? [set, clearCookie("portal_session", "/", SECURE_COOKIES)] : [set];
}

function setSession(res: ServerResponse, headers: string[]): void {
  res.setHeader("set-cookie", headers);
}

const playgroundClaims = PLAYGROUND ? coreClaimStore(CORE, CORE_SIGNING_SECRET, "portal") : null;

export function mintBucketOf(ip: string): string {
  if (!ip.includes(":")) return ip;
  const zoneless = ip.split("%")[0] ?? "";
  if (zoneless.toLowerCase().startsWith("::ffff:") && zoneless.includes(".")) return zoneless.slice(7);
  const [headRaw = "", tailRaw = ""] = zoneless.split("::", 2);
  const head = headRaw ? headRaw.split(":") : [];
  const tail = tailRaw ? tailRaw.split(":") : [];
  const groups = [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  const prefix = groups
    .slice(0, 4)
    .map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
  return `${prefix}::/64`;
}

export function playgroundBusyHtml(): string {
  return cardPage({
    title: "Playground is busy",
    heading: "The playground is busy",
    msg: "We couldn't start a fresh playground session for you right now. Waiting a little while and reloading resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/">Try again</a>`,
    help: "Playground sessions are limited per visitor to keep the demo responsive for everyone.",
  });
}

export function playgroundRestrictedHtml(): string {
  return cardPage({
    title: "Not available in the playground",
    heading: "Not available in the playground",
    msg: "Connecting accounts and dropping secrets are disabled for anonymous playground sessions — clearing your cookie would orphan real credentials.",
    icon: LOCK_ICON,
    actions: `<a class="btn primary" href="/">Back to the playground</a>`,
    help: "Sign in with a real account at /auth/login to use this link.",
  });
}

async function mintPlaygroundSession(req: IncomingMessage, res: ServerResponse): Promise<SessionClaims | null> {
  if (!playgroundClaims) return null;
  const allowed = await withinRateLimit(playgroundClaims, {
    secret: SESSION_SECRET ?? DEV_SECRET,
    kind: "playground-mint",
    value: mintBucketOf(clientIpOf(req)),
    limit: PLAYGROUND_MINTS_PER_IP,
    windowS: PLAYGROUND_MINT_WINDOW_S,
    nowMs: Date.now(),
  }).catch((e) => {
    if (e instanceof ClaimStoreUnavailableError) return false;
    throw e;
  });
  if (!allowed) return null;
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = {
    k: "session",
    sub: `playground-${randomToken(8)}`,
    org: ORG,
    name: "Guest",
    anon: true,
    auth: now,
    iat: now,
    exp: now + SESSION_TTL_S,
  };
  setSession(res, sessionCookieSet(seal(session, sessionKey)));
  return session;
}

function renewSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  const session = openSession(
    readCookie(req.headers.cookie, "portal_session"),
    sessionKey,
    Date.now(),
    ORG,
    SESSION_MAX_TTL_S,
  );
  if (!session) return;
  const now = Math.floor(Date.now() / 1000);
  if (now - session.iat < SESSION_RENEW_AFTER_S) return;
  const authenticatedAt = session.auth ?? session.iat;
  const renewed: SessionClaims = {
    ...session,
    auth: authenticatedAt,
    iat: now,
    exp: Math.min(now + SESSION_TTL_S, authenticatedAt + SESSION_MAX_TTL_S),
  };
  setSession(res, sessionCookieSet(seal(renewed, sessionKey)));
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error("[portal] 500 %s %s: %s", req.method ?? "?", (req.url ?? "?").split("?")[0], String(err));
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
    else res.end();
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const rawTarget = req.url ?? "/";
  const url = new URL(rawTarget, "http://portal.local");
  const pathname = url.pathname;

  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");

  void refreshSurfaceConfig();

  if (method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true });

  if (method === "GET" && (pathname === "/favicon.ico" || pathname === "/favicon.svg")) {
    return serveEmojiFavicon(res, process.env.PORTAL_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F", "max-age=86400");
  }

  if (pathname === "/auth/login" && method === "GET") return authLogin(req, res, url);
  if (pathname === "/auth/callback" && method === "GET") return authCallback(req, res, url);
  if (pathname === "/auth/admin-login") return adminLogin(req, res);
  if (pathname === "/auth/logout" && method === "POST") {
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden" });
    setSession(res, [
      clearCookie("portal_session", "/", SECURE_COOKIES, COOKIE_DOMAIN),
      ...(COOKIE_DOMAIN ? [clearCookie("portal_session", "/", SECURE_COOKIES)] : []),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
      ...(LOCAL_AUTH_BYPASS && isLoopbackAddress(req.socket.remoteAddress)
        ? [setCookie(LOCAL_LOGOUT_COOKIE, "1", { path: "/", maxAge: SESSION_TTL_S, secure: SECURE_COOKIES })]
        : []),
    ]);
    if (wantsHtml(req)) {
      res.writeHead(303, { location: "/", "cache-control": "no-store" });
      return void res.end();
    }
    return json(res, 200, { ok: true });
  }

  const brokerPath = brokerRouteFor(method, pathname);
  if (brokerPath) {
    if (method !== "GET" && !sameOriginRequest(req))
      return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    return proxyToUpstream(
      req,
      res,
      { baseUrl: AUTH_BROKER_UPSTREAM, path: brokerPath, search: url.search },
      FORWARD_BROKER_HEADERS,
      { "x-qm-client-ip": clientIpOf(req) },
    );
  }

  let session = currentSession(req);
  if (session) renewSessionCookie(req, res);

  if (pathname === "/auth/impersonate" && method === "POST") {
    if (!session) return json(res, 401, { error: "sign in" });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (!(await isAdmin(session.sub))) return json(res, 403, { error: "forbidden", message: "admin access required" });
    const target = (url.searchParams.get("target") ?? "").trim();
    if (!target) return json(res, 400, { error: "bad_request", message: "target required" });
    if (target === session.sub) return json(res, 400, { error: "bad_request", message: "cannot impersonate yourself" });
    const result = await coreImpersonate("start", session.sub, target);
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
    if (session && imp && imp.actor === session.sub) await coreImpersonate("stop", session.sub, imp.target);
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

  if (method === "POST" && /^\/v1\/webhooks\/incoming\/[^/]+$/.test(pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_WEBHOOK_HEADERS);
  }

  const consentBounce = (): void => {
    res.writeHead(302, { location: `/auth/login?returnTo=${encodeURIComponent(`${pathname}${url.search}`)}` });
    return void res.end();
  };
  const redeem = /^\/connect\/redeem\/([^/]+)$/.exec(pathname);
  if (method === "GET" && redeem) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleConsentRedeem(res, {
      corePath: `/v1/connectors/oauth/consent/redeem/${redeem[1]}${url.search}`,
      session,
    });
  }
  const selfConnect = /^\/connect\/([^/]+)\/self-connect$/.exec(pathname);
  if (method === "GET" && selfConnect) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleSelfConnect(res, { provider: decodeURIComponent(selfConnect[1] ?? ""), session });
  }

  if (isOAuthPublicPassthrough(method, pathname)) {
    return proxyToUpstream(req, res, { baseUrl: CORE, path: pathname, search: url.search }, FORWARD_OAUTH_HEADERS);
  }

  const dropForm = /^\/drop\/([^/]+)\/form$/.exec(pathname);
  if (method === "GET" && dropForm) {
    if (!session) return consentBounce();
    if (session.anon) return sendHtml(res, 403, playgroundRestrictedHtml());
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropForm[1]}/form${url.search}`,
      session,
    });
  }
  const dropSubmit = /^\/drop\/([^/]+)$/.exec(pathname);
  if (method === "POST" && dropSubmit) {
    if (!session)
      return json(res, 401, {
        error: "sign in",
        message: "your session expired — re-open the link, sign in, and paste again",
      });
    if (!sameOriginRequest(req)) return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
    if (session.anon)
      return json(res, 403, { error: "forbidden", message: "secret drops are disabled for playground sessions" });
    return handleSecretDrop(req, res, {
      method,
      corePath: `/v1/keychain/drops/${dropSubmit[1]}${url.search}`,
      session,
    });
  }

  if (isDeploymentLayerPassthrough(method, pathname)) {
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
  if (!DEPLOYMENTS_ENABLED && (seg === "d" || seg === "deployments")) return json(res, 404, { error: "not_found" });
  const isDeployment = DEPLOYMENTS_ENABLED && (seg === "d" || seg === "deployments");
  const surfaceKey = Object.hasOwn(UPSTREAMS, seg) && seg !== "web-ui" ? seg : "web-ui";

  if (!session) {
    if (method === "GET" && wantsHtml(req)) {
      if (PLAYGROUND) {
        session = await mintPlaygroundSession(req, res);
        if (!session) return sendHtml(res, 429, playgroundBusyHtml());
      } else {
        const returnTo = encodeURIComponent(`${pathname}${url.search}`);
        res.writeHead(302, { location: `/auth/login?returnTo=${returnTo}` });
        return void res.end();
      }
    } else {
      return json(res, 401, { error: "sign in" });
    }
  }

  if (method !== "GET" && method !== "HEAD" && !sameOriginRequest(req)) {
    return json(res, 403, { error: "forbidden", message: "cross-origin request refused" });
  }

  if (isDeployment) {
    if (session.anon) return json(res, 403, { error: "forbidden", message: "sign in to view deployed apps" });
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
    });
  }

  const key = surfaceKey as string;
  if (key === "admin") {
    if (session.anon) {
      if (wantsHtml(req)) return sendHtml(res, 403, nonAdminDeniedHtml({ sub: session.sub, org: session.org }));
      return json(res, 403, { error: "forbidden", message: "admin access required" });
    }
    const probe = await adminProbe(session.sub);
    if (!probe.isAdmin) {
      if (wantsHtml(req)) {
        const page = probe.failed ? adminUnavailableHtml() : nonAdminDeniedHtml({ sub: session.sub, org: session.org });
        return sendHtml(res, 403, page);
      }
      return json(res, 403, { error: "forbidden", message: "admin access required" });
    }
  }

  if (key === "web-ui" && method === "GET" && wantsHtml(req)) {
    await refreshSurfaceConfig();
    if (modelProviderConfigured === false) {
      if (await isAdmin(session.sub)) {
        res.writeHead(302, { location: "/admin/onboarding", "cache-control": "no-store" });
        return void res.end();
      }
      return sendHtml(res, 503, notConfiguredHtml());
    }
  }

  let principal = session.sub;
  let impersonator: string | undefined;
  if (key === "web-ui") {
    const imp = openImpersonation(readCookie(req.headers.cookie, "portal_impersonate"), impersonateKey, Date.now());
    if (imp && imp.actor === session.sub && imp.org === session.org && (await isAdmin(session.sub))) {
      principal = imp.target;
      impersonator = session.sub;
    }
  }

  const forwardPath = key === "web-ui" ? pathname : pathname.slice(`/${key}`.length) || "/";
  if (key === "web-ui" && forwardPath === "/app-edit") res.removeHeader("x-frame-options");
  return proxyToSurface(req, res, {
    upstreamBase: UPSTREAMS[key]!,
    forwardPath,
    search: url.search,
    cookieName: COOKIE_FOR[key]!,
    principal,
    ...(!impersonator && session.name ? { displayName: session.name } : {}),
    ...(impersonator ? { impersonator } : {}),
    ...(PORTAL_IDENTITY_SECRET ? { identitySecret: PORTAL_IDENTITY_SECRET } : {}),
  });
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
  res.writeHead(303, { location: "/admin/", "cache-control": "no-store" });
  res.end();
}

function setAuthenticatedSession(res: ServerResponse, sub: string, name = ""): void {
  const now = Math.floor(Date.now() / 1000);
  const session: SessionClaims = {
    k: "session",
    sub,
    org: ORG,
    auth: now,
    iat: now,
    exp: now + SESSION_TTL_S,
    ...(name ? { name } : {}),
  };
  setSession(res, [
    ...sessionCookieSet(seal(session, sessionKey)),
    clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
    clearCookie("portal_impersonate", "/", SECURE_COOKIES),
  ]);
}

function authLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"), PUBLIC_URL, APPS_DOMAIN);
  const localSession = localDevSession(req, Date.now(), true);
  if (localSession) {
    setSession(res, [
      ...sessionCookieSet(seal(localSession, sessionKey)),
      clearCookie("portal_oidc_tmp", "/auth", SECURE_COOKIES),
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
  if (!tmp) return fail("login session expired — please try again");
  if (!code || !stateParam || !safeEqual(stateParam, tmp.state)) return fail("invalid login state");
  if (!consumeState(tmp.state)) return fail("login already used — please try again");

  let sub: string;
  let name = "";
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
    sub = await resolvePrincipal(PRINCIPAL_RULE, { sub: infoSub, claims, userinfo: info }, (email) =>
      coreEmailAllowed(CORE, CORE_SIGNING_SECRET, email, "portal"),
    );
    const rawName = info.name ?? claims.name;
    if (typeof rawName === "string") name = rawName.trim().slice(0, 200);
  } catch (e) {
    return fail(errMessage(e, "sign-in failed"));
  }

  setAuthenticatedSession(res, sub, name);
  res.writeHead(302, {
    location: sanitizeReturnTo(tmp.returnTo, PUBLIC_URL, APPS_DOMAIN),
    "cache-control": "no-store",
  });
  res.end();
}

export function bootChecks(): void {
  const problems: string[] = [];
  if (!AUTH_BROKER_UPSTREAM && originOf(OIDC.authEndpoint) && originOf(OIDC.authEndpoint) === originOf(PUBLIC_URL)) {
    problems.push(
      "OIDC_AUTH_ENDPOINT is on the portal's own origin but AUTH_BROKER_UPSTREAM is unset — every sign-in would redirect from /auth/login back into the portal forever; wire AUTH_BROKER_UPSTREAM to the auth service or point OIDC_AUTH_ENDPOINT at a real identity provider",
    );
  }
  if (LOCAL_AUTH_BYPASS_REQUESTED && IS_PROD) {
    problems.push("PORTAL_LOCAL_AUTH_BYPASS may not be enabled in production");
  }
  if (LOCAL_AUTH_BYPASS_REQUESTED && !isLocalPortalUrl(PUBLIC_URL)) {
    problems.push("PORTAL_LOCAL_AUTH_BYPASS requires a localhost, 127.0.0.1, or ::1 PORTAL_PUBLIC_URL");
  }
  if (PLAYGROUND) {
    if (!Number.isInteger(PLAYGROUND_MINTS_PER_IP) || PLAYGROUND_MINTS_PER_IP < 1 || PLAYGROUND_MINTS_PER_IP > 64) {
      problems.push(
        "PORTAL_PLAYGROUND_MINTS_PER_IP must be an integer between 1 and 64 (the core grants at most 64 claim slots per request)",
      );
    }
    if (
      !Number.isInteger(PLAYGROUND_MINT_WINDOW_S) ||
      PLAYGROUND_MINT_WINDOW_S < 60 ||
      PLAYGROUND_MINT_WINDOW_S > 86400
    ) {
      problems.push(
        "PORTAL_PLAYGROUND_MINT_WINDOW_S must be an integer between 60 and 86400 (the core's claim horizon is 24 hours)",
      );
    }
    if (COOKIE_DOMAIN || APPS_DOMAIN) {
      problems.push(
        "PORTAL_PLAYGROUND requires PORTAL_COOKIE_DOMAIN and the apps domain (PORTAL_APPS_DOMAIN / DEPLOY_APPS_DOMAIN) unset — a domain-wide cookie would carry anonymous sessions to app subdomains, which never see the anon flag",
      );
    }
    if (DEPLOYMENTS_ENABLED) {
      problems.push(
        "PORTAL_PLAYGROUND requires PORTAL_DEPLOYMENTS_ENABLED unset — anonymous visitors must not reach deployed apps",
      );
    }
  }
  if (APPS_DOMAIN && !COOKIE_DOMAIN) {
    problems.push(
      `the apps domain (${APPS_DOMAIN}) is not a subdomain of the portal host, so the cookie domain cannot be derived — set PORTAL_COOKIE_DOMAIN to the parent domain covering both (app returnTo without a domain-wide session cookie loops sign-in forever)`,
    );
  }
  if (COOKIE_DOMAIN && !hostIsWithinDomain(hostOf(PUBLIC_URL), COOKIE_DOMAIN)) {
    problems.push(`PORTAL_COOKIE_DOMAIN (${COOKIE_DOMAIN}) must cover PORTAL_PUBLIC_URL's host`);
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
    if (!PUBLIC_URL.startsWith("https://")) problems.push("PORTAL_PUBLIC_URL must be https in production");
    if (!OIDC.authEndpoint.startsWith("https://")) {
      problems.push(`OIDC_AUTH_ENDPOINT must be https — the browser is sent there: ${OIDC.authEndpoint}`);
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
          "AUTH_BROKER_UPSTREAM must address a private-network host — the broker is never exposed directly",
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

function isMissingOrPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate);
}

function validEmailDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export function startServer(): void {
  bootChecks();
  server.listen(PORT, () => {
    console.log(`[portal] public front door on http://localhost:${PORT} → web-ui/admin over 6PN (org ${ORG})`);
    if (!SESSION_SECRET)
      console.warn("[portal] PORTAL_SESSION_SECRET unset — using an INSECURE dev key (dev/test only)");
    if (!SECURE_COOKIES)
      console.warn("[portal] PORTAL_PUBLIC_URL is not https — cookies are NOT Secure (dev/test only)");
    if (LOCAL_AUTH_BYPASS)
      console.warn(
        `[portal] PORTAL_LOCAL_AUTH_BYPASS=1 -- using ${LOCAL_AUTH_PRINCIPAL} as the local session principal (dev/test only)`,
      );
    if (PLAYGROUND)
      console.warn(
        `[portal] PORTAL_PLAYGROUND=1 -- unauthenticated visitors get anonymous browser-pinned sessions (${PLAYGROUND_MINTS_PER_IP} mints per IP per ${PLAYGROUND_MINT_WINDOW_S}s); admin sign-in stays on /auth/login`,
      );
    if (PLAYGROUND && !ON_FLY && XFF_TRUSTED_HOPS === 0)
      console.warn(
        "[portal] playground mint limits key on the socket address — set PORTAL_XFF_TRUSTED_HOPS when behind a reverse proxy, or every visitor shares one bucket",
      );
    console.log(
      "[portal] /admin access is derived (portal → admin surface /api/whoami over 6PN → core canAdminister); the core's ADMIN_GRANTS is the one source of admin identity",
    );
  });
}

export { handle, server };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
