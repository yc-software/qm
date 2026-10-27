import { type IncomingMessage } from "node:http";
import { trustedEntryConfig } from "./trusted-entry.ts";
import { parseAllowedOrigins } from "./cors.ts";
import { deriveKey } from "./session.ts";
import { type OidcConfig, type PrincipalRule, hostedDomainHint } from "./oidc.ts";
import { isPrivateNetworkIp } from "../../chassis/src/network.ts";
import { reportFailure } from "../../chassis/src/error-reporting.ts";
import { edgeTenant, tenantPublicUrl } from "../../chassis/src/tenant-hosts.ts";
import { deriveTenantSecret, type TenantSettings } from "../../chassis/src/tenant-settings.ts";
import { validEmail } from "../../chassis/src/email.ts";
import { coreSigningSecret, portalIdentitySecret, isMissingOrPlaceholder, portFromEnv } from "../../chassis/src/env.ts";

export const PORT = portFromEnv(8097);

const PUBLIC_URL = (process.env.PORTAL_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

export const SESSION_SECRET = process.env.PORTAL_SESSION_SECRET;

export const SESSION_TTL_S = Number(process.env.PORTAL_SESSION_TTL_S ?? 604800);

export const SESSION_MAX_TTL_S = Math.max(2592000, 3 * SESSION_TTL_S);

export const SESSION_RENEW_AFTER_S = Math.floor(SESSION_TTL_S / 2);

const APPS_DOMAIN = process.env.PORTAL_APPS_DOMAIN || process.env.DEPLOY_APPS_DOMAIN || undefined;

const COOKIE_DOMAIN =
  process.env.PORTAL_COOKIE_DOMAIN ||
  (APPS_DOMAIN ? derivedCookieDomain(hostOf(process.env.PORTAL_PUBLIC_URL ?? ""), APPS_DOMAIN) : undefined);

const IS_PROD = process.env.NODE_ENV === "production";

export const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");

const ORIGIN = (() => {
  try {
    return new URL(PUBLIC_URL).origin;
  } catch {
    return "";
  }
})();

const API_ALLOWED_ORIGINS = parseAllowedOrigins(process.env.PORTAL_API_ALLOWED_ORIGINS);

const LOCAL_AUTH_BYPASS_REQUESTED = process.env.PORTAL_LOCAL_AUTH_BYPASS === "1";

export const LOCAL_AUTH_BYPASS = LOCAL_AUTH_BYPASS_REQUESTED && !IS_PROD && isLocalPortalUrl(PUBLIC_URL);

export const LOCAL_AUTH_PRINCIPAL = process.env.PORTAL_DEV_PRINCIPAL || process.env.USER || "dev-admin";

export const PLAYGROUND = process.env.PORTAL_PLAYGROUND === "1";

export const DEPLOYMENTS_ENABLED = !PLAYGROUND;

export const PLAYGROUND_MINTS_PER_IP = 30;

export const PLAYGROUND_MINT_WINDOW_S = 3600;

export const WEB_UI_UPSTREAM = (process.env.WEB_UI_UPSTREAM ?? "http://localhost:8096").replace(/\/$/, "");

function isSlackIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname;
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}

const AUTH_BROKER_UPSTREAM = (process.env.AUTH_BROKER_UPSTREAM ?? "").replace(/\/$/, "");

export const AUTH_BROKER_PREFIX = (process.env.AUTH_BROKER_PREFIX ?? "/idp").replace(/\/$/, "");

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
  ...(AUTH_BROKER_UPSTREAM ? { headers: { "x-forwarded-host": hostOf(PUBLIC_URL) } } : {}),
};

const OIDC_JWKS_CONFIGURED = Boolean(process.env.OIDC_JWKS_URI?.trim());

const BROKER_PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/authorize" },
  { method: "POST", path: "/authorize" },
  { method: "GET", path: "/verify" },
  { method: "POST", path: "/verify" },
];

export function brokerRouteFor(method: string, pathname: string): string | null {
  if (!site().brokerUpstream || !AUTH_BROKER_PREFIX || !pathname.startsWith(`${AUTH_BROKER_PREFIX}/`)) return null;
  const rest = pathname.slice(AUTH_BROKER_PREFIX.length);
  return BROKER_PUBLIC_ROUTES.some((route) => route.method === method && route.path === rest) ? rest : null;
}

export const XFF_TRUSTED_HOPS = Math.max(0, Math.trunc(Number(process.env.PORTAL_XFF_TRUSTED_HOPS ?? 0)) || 0);

export function clientIpOf(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress || "unknown";
  if (XFF_TRUSTED_HOPS === 0) return socket;
  const forwarded = req.headers["x-forwarded-for"];
  const hops = (typeof forwarded === "string" ? forwarded : "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - XFF_TRUSTED_HOPS] ?? socket;
}

export const PRINCIPAL_RULE: PrincipalRule = {
  requireCoreAdmission: Boolean(AUTH_BROKER_UPSTREAM),
  claim: (process.env.OIDC_PRINCIPAL_CLAIM ?? "email") as PrincipalRule["claim"],
  allowedEmailDomain: process.env.OIDC_ALLOWED_EMAIL_DOMAIN || undefined,
  allowedEmails: process.env.OIDC_ALLOWED_EMAILS?.split(",")
    .map((email) => email.trim())
    .filter(Boolean),
};

const DEV_SECRET = "dev-only-insecure-portal-session-secret";

export interface Site {
  tenantId: string;
  publicUrl: string;
  origin: string;
  appsDomain: string | undefined;
  cookieDomain: string | undefined;
  oidc: OidcConfig | null;
  brokerUpstream: string;
  trusted: OidcConfig | null;
  trustedLabel: string | undefined;
  trustedAdmin: boolean;
  faviconSvg: string | undefined;
  apiAllowedOrigins: ReadonlySet<string>;
  sessionSecret: string;
  sessionKey: Buffer;
  tmpKey: Buffer;
  impersonateKey: Buffer;
}

function siteSecrets(tenantId: string): Pick<Site, "sessionSecret" | "sessionKey" | "tmpKey" | "impersonateKey"> {
  const base = SESSION_SECRET ?? DEV_SECRET;
  const sessionSecret = tenantId ? deriveTenantSecret(base, tenantId) : base;
  return {
    sessionSecret,
    sessionKey: deriveKey(sessionSecret, "portal.session.v1"),
    tmpKey: deriveKey(sessionSecret, "portal.tmp.v1"),
    impersonateKey: deriveKey(sessionSecret, "portal.impersonate.v1"),
  };
}

const IDENTITY_SECRET_DISTINCT = (() => {
  const signing = coreSigningSecret();
  const identity = portalIdentitySecret();
  return Boolean(signing && identity && identity.length >= 32 && identity !== signing);
})();

function trustedSite(trusted: OidcConfig | null, label: string | undefined, admin: boolean) {
  if (admin && (!trusted || !IDENTITY_SECRET_DISTINCT))
    throw new Error("Trusted administrator provisioning requires trusted OIDC and a distinct portal identity secret");
  return { trusted, trustedLabel: trusted ? label?.trim() || undefined : undefined, trustedAdmin: admin };
}

const HOME_SITE: Site = {
  tenantId: "",
  publicUrl: PUBLIC_URL,
  origin: ORIGIN,
  appsDomain: APPS_DOMAIN,
  cookieDomain: COOKIE_DOMAIN,
  oidc: OIDC,
  brokerUpstream: AUTH_BROKER_UPSTREAM,
  ...trustedSite(
    trustedEntryConfig(process.env, PUBLIC_URL),
    process.env.PORTAL_TRUSTED_OIDC_LABEL,
    process.env.PORTAL_TRUSTED_OIDC_ADMIN === "1",
  ),
  faviconSvg: undefined,
  apiAllowedOrigins: API_ALLOWED_ORIGINS.origins,
  ...siteSecrets(""),
};

function brokerOidc(publicUrl: string, tenantId: string): OidcConfig {
  const issuer = `${publicUrl}${AUTH_BROKER_PREFIX}`;
  return {
    ...OIDC,
    clientSecret: deriveTenantSecret(OIDC.clientSecret, tenantId),
    issuer,
    authEndpoint: `${issuer}/authorize`,
    redirectUri: `${publicUrl}/auth/callback`,
    headers: { "x-forwarded-host": hostOf(publicUrl) },
  };
}

function tenantSite(tenant: TenantSettings & { id: string }): Site {
  const publicUrl = tenantPublicUrl(tenant);
  const appsDomain = tenant.appsDomain || undefined;
  const client = tenant.oidcClientId
    ? { clientId: tenant.oidcClientId, clientSecret: tenant.secrets.oidcClientSecret ?? "" }
    : undefined;
  return {
    tenantId: tenant.id,
    publicUrl,
    origin: originOf(publicUrl),
    appsDomain,
    cookieDomain: appsDomain ? derivedCookieDomain(hostOf(publicUrl), appsDomain) : undefined,
    oidc: AUTH_BROKER_UPSTREAM ? brokerOidc(publicUrl, tenant.id) : null,
    brokerUpstream: AUTH_BROKER_UPSTREAM,
    ...trustedSite(
      client ? trustedEntryConfig(process.env, publicUrl, client) : null,
      tenant.oidcLabel,
      tenant.oidcAdmin,
    ),
    faviconSvg: tenant.faviconSvg,
    apiAllowedOrigins: new Set(),
    ...siteSecrets(tenant.id),
  };
}

const tenantSites = new WeakMap<TenantSettings, Site>();

function servedSite(tenant: TenantSettings & { id: string }): Site {
  try {
    return tenantSite(tenant);
  } catch (error) {
    reportFailure(`portal: tenant ${tenant.slug} trusted sign-in is misconfigured and stays off`, error);
    return tenantSite({ ...tenant, oidcClientId: undefined, oidcAdmin: false });
  }
}

export function site(): Site {
  const tenant = edgeTenant();
  if (!tenant?.id) return HOME_SITE;
  let found = tenantSites.get(tenant);
  if (!found) {
    found = servedSite({ ...tenant, id: tenant.id });
    tenantSites.set(tenant, found);
  }
  return found;
}

export const IMPERSONATE_TTL_S = 3600;

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
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return isPrivateNetworkIp(host);
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
  if (LOCAL_AUTH_BYPASS_REQUESTED && !isLocalPortalUrl(PUBLIC_URL)) {
    problems.push("PORTAL_LOCAL_AUTH_BYPASS requires a localhost, 127.0.0.1, or ::1 PORTAL_PUBLIC_URL");
  }
  if (PLAYGROUND && (COOKIE_DOMAIN || APPS_DOMAIN)) {
    problems.push(
      "PORTAL_PLAYGROUND requires PORTAL_COOKIE_DOMAIN and the apps domain (PORTAL_APPS_DOMAIN / DEPLOY_APPS_DOMAIN) unset — a domain-wide cookie would carry anonymous sessions to app subdomains, which never see the anon flag",
    );
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
  if (!Number.isFinite(SESSION_TTL_S) || SESSION_TTL_S <= 0) {
    problems.push("PORTAL_SESSION_TTL_S must be a positive number of seconds");
  }
  if ((PRINCIPAL_RULE.allowedEmailDomain || PRINCIPAL_RULE.allowedEmails?.length) && PRINCIPAL_RULE.claim !== "email") {
    problems.push("OIDC_ALLOWED_EMAIL_DOMAIN and OIDC_ALLOWED_EMAILS require OIDC_PRINCIPAL_CLAIM=email");
  }
  if (IS_PROD) {
    if (isMissingOrPlaceholder(SESSION_SECRET))
      problems.push("PORTAL_SESSION_SECRET is required and may not be a placeholder in production");
    if (isMissingOrPlaceholder(coreSigningSecret()))
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
    if (PRINCIPAL_RULE.allowedEmails?.some((email) => !validEmail(email) || isMissingOrPlaceholder(email))) {
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
    if (SESSION_SECRET && coreSigningSecret() && SESSION_SECRET === coreSigningSecret()) {
      problems.push("PORTAL_SESSION_SECRET must differ from CORE_SIGNING_SECRET");
    }
    if (!PUBLIC_URL.startsWith("https://")) problems.push("PORTAL_PUBLIC_URL must be https in production");
    if (!OIDC.authEndpoint.startsWith("https://")) {
      problems.push(`OIDC_AUTH_ENDPOINT must be https, since the browser is sent there: ${OIDC.authEndpoint}`);
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
