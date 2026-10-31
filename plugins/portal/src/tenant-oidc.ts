import { isMissingOrPlaceholder } from "../../chassis/src/env.ts";
import { hostedDomainHint, type OidcConfig, type PrincipalRule } from "./oidc.ts";

export interface TenantOidcContext {
  publicUrl: string;
  brokerUpstream: string;
  brokerPrefix: string;
  isProd: boolean;
}

export interface TenantOidc {
  oidc: OidcConfig;
  rule: PrincipalRule;
  problems: string[];
}

export function originOf(raw: string): string {
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

function isSlackIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname;
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
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

export function tenantOidc(values: Readonly<Record<string, string>>, ctx: TenantOidcContext): TenantOidc {
  const issuer = values.OIDC_ISSUER ?? "https://slack.com";
  const oidc: OidcConfig = {
    authEndpoint: values.OIDC_AUTH_ENDPOINT ?? "https://slack.com/openid/connect/authorize",
    tokenEndpoint: values.OIDC_TOKEN_ENDPOINT ?? "https://slack.com/api/openid.connect.token",
    userinfoEndpoint: values.OIDC_USERINFO_ENDPOINT ?? "https://slack.com/api/openid.connect.userInfo",
    clientId: values.OIDC_CLIENT_ID ?? "",
    clientSecret: values.OIDC_CLIENT_SECRET ?? "",
    scopes: values.OIDC_SCOPES ?? "openid profile email",
    redirectUri: `${ctx.publicUrl}/auth/callback`,
    issuer,
    jwksUri: values.OIDC_JWKS_URI ?? "https://slack.com/openid/connect/keys",
    expectedTeamId: values.PORTAL_EXPECTED_TEAM_ID || undefined,
    prompt: values.OIDC_PROMPT || undefined,
    hostedDomain: hostedDomainHint(issuer, values.OIDC_ALLOWED_EMAIL_DOMAIN),
  };
  const rule: PrincipalRule = {
    requireCoreAdmission: Boolean(ctx.brokerUpstream),
    claim: (values.OIDC_PRINCIPAL_CLAIM ?? "email") as PrincipalRule["claim"],
    allowedEmailDomain: values.OIDC_ALLOWED_EMAIL_DOMAIN || undefined,
    allowedEmails: values.OIDC_ALLOWED_EMAILS?.split(",")
      .map((email) => email.trim())
      .filter(Boolean),
  };
  return { oidc, rule, problems: oidcProblems(oidc, rule, Boolean(values.OIDC_JWKS_URI?.trim()), ctx) };
}

function oidcProblems(
  oidc: OidcConfig,
  rule: PrincipalRule,
  jwksConfigured: boolean,
  ctx: TenantOidcContext,
): string[] {
  const problems: string[] = [];
  const { publicUrl, brokerUpstream, brokerPrefix } = ctx;
  if (!brokerUpstream && originOf(oidc.authEndpoint) && originOf(oidc.authEndpoint) === originOf(publicUrl)) {
    problems.push(
      "OIDC_AUTH_ENDPOINT is on the portal's own origin but AUTH_BROKER_UPSTREAM is unset — every sign-in would redirect from /auth/login back into the portal forever; wire AUTH_BROKER_UPSTREAM to the auth service or point OIDC_AUTH_ENDPOINT at a real identity provider",
    );
  }
  if (rule.claim !== "sub" && rule.claim !== "email") {
    problems.push(`OIDC_PRINCIPAL_CLAIM must be "sub" or "email" (got "${rule.claim}")`);
  }
  if ((rule.allowedEmailDomain || rule.allowedEmails?.length) && rule.claim !== "email") {
    problems.push("OIDC_ALLOWED_EMAIL_DOMAIN and OIDC_ALLOWED_EMAILS require OIDC_PRINCIPAL_CLAIM=email");
  }
  if (!ctx.isProd) {
    if (!oidc.clientId.trim()) problems.push("OIDC_CLIENT_ID is required");
    return problems;
  }
  if (isMissingOrPlaceholder(oidc.clientId))
    problems.push("OIDC_CLIENT_ID is required and may not be a placeholder in production");
  if (isMissingOrPlaceholder(oidc.clientSecret))
    problems.push("OIDC_CLIENT_SECRET is required and may not be a placeholder in production");
  if (
    rule.allowedEmailDomain &&
    (isMissingOrPlaceholder(rule.allowedEmailDomain) || !validEmailDomain(rule.allowedEmailDomain))
  ) {
    problems.push("OIDC_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set");
  }
  if (rule.allowedEmails?.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || isMissingOrPlaceholder(email))) {
    problems.push("OIDC_ALLOWED_EMAILS must be a comma-separated list of valid, non-placeholder email addresses");
  }
  if (!rule.allowedEmailDomain && !rule.allowedEmails?.length && isMissingOrPlaceholder(oidc.expectedTeamId)) {
    problems.push(
      "production requires OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_EMAIL_DOMAIN, or PORTAL_EXPECTED_TEAM_ID as an identity-provider trust boundary",
    );
  }
  if (oidc.expectedTeamId !== undefined && isMissingOrPlaceholder(oidc.expectedTeamId)) {
    problems.push("PORTAL_EXPECTED_TEAM_ID is optional, but may not be a placeholder when configured");
  }
  if (!isSlackIssuer(oidc.issuer) && !jwksConfigured) problems.push("OIDC_JWKS_URI is required for a non-Slack issuer");
  if (!oidc.authEndpoint.startsWith("https://")) {
    problems.push(`OIDC_AUTH_ENDPOINT must be https, since the browser is sent there: ${oidc.authEndpoint}`);
  }
  const brokerOrigin = brokerUpstream && isPrivateNetworkUrl(brokerUpstream) ? originOf(brokerUpstream) : "";
  for (const ep of [oidc.tokenEndpoint, oidc.userinfoEndpoint, oidc.jwksUri]) {
    if (!ep.startsWith("https://") && !(brokerOrigin && originOf(ep) === brokerOrigin)) {
      problems.push(`OIDC endpoint must be https unless it is the built-in broker on the private network: ${ep}`);
    }
  }
  if (brokerUpstream && oidc.issuer !== `${publicUrl}${brokerPrefix}`) {
    problems.push(`OIDC_ISSUER must be ${publicUrl}${brokerPrefix} when the built-in broker is wired`);
  }
  if (brokerUpstream && oidc.authEndpoint !== `${publicUrl}${brokerPrefix}/authorize`) {
    problems.push(`OIDC_AUTH_ENDPOINT must be ${publicUrl}${brokerPrefix}/authorize when the built-in broker is wired`);
  }
  return problems;
}
