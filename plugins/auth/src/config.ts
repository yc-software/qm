import type { SmtpTlsMode } from "./smtp.ts";

type EmailTransportKind = "resend" | "smtp";

interface SmtpSettings {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: SmtpTlsMode;
}

export interface AuthConfig {
  issuer: string;
  publicPath: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  signingJwk: Record<string, unknown> | null;
  tokenSecret: string;
  allowedEmails: readonly string[];
  allowedEmailDomain: string | undefined;
  emailFrom: string;
  brandName: string;
  transport: EmailTransportKind;
  resendApiKey: string;
  smtp: SmtpSettings;
  linkTtlS: number;
  codeTtlS: number;
  accessTtlS: number;
  requestTtlS: number;
  sendWindowS: number;
  sendLimitPerEmail: number;
  sendLimitPerIp: number;
  coreApiUrl: string;
  coreSigningSecret: string | undefined;
}

const PLACEHOLDER = /^(replace-me|placeholder|changeme|todo)$/i;
const MAX_RATE_LIMIT_SLOTS = 64;

function isMissingOrPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || PLACEHOLDER.test(candidate);
}

function numberFrom(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function listFrom(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function issuerPath(issuer: string): string {
  try {
    return new URL(issuer).pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function smtpTlsFrom(mode: string | undefined, port: string | undefined): SmtpTlsMode {
  const declared = mode?.trim();
  if (declared === "implicit" || declared === "none" || declared === "starttls") return declared;
  return port?.trim() === "465" ? "implicit" : "starttls";
}

function parseJwk(raw: string | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const issuer = (env.AUTH_ISSUER ?? `http://localhost:${env.PORT ?? 8099}`).replace(/\/$/, "");
  const publicPath = issuerPath(issuer);
  const transport: EmailTransportKind = env.AUTH_EMAIL_TRANSPORT?.trim() === "smtp" ? "smtp" : "resend";
  return {
    issuer,
    publicPath,
    clientId: env.AUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: env.AUTH_CLIENT_SECRET ?? "",
    redirectUri: env.AUTH_REDIRECT_URI?.trim() ?? "",
    signingJwk: parseJwk(env.AUTH_SIGNING_JWK),
    tokenSecret: env.AUTH_TOKEN_SECRET ?? "",
    allowedEmails: listFrom(env.AUTH_ALLOWED_EMAILS),
    allowedEmailDomain: env.AUTH_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase() || undefined,
    emailFrom: env.AUTH_EMAIL_FROM?.trim() ?? "",
    brandName: env.AUTH_BRAND_NAME?.trim() || "qm",
    transport,
    resendApiKey: env.RESEND_API_KEY ?? "",
    smtp: {
      host: env.SMTP_HOST?.trim() ?? "",
      port: numberFrom(env.SMTP_PORT, 587),
      username: env.SMTP_USERNAME ?? "",
      password: env.SMTP_PASSWORD ?? "",
      tls: smtpTlsFrom(env.SMTP_TLS, env.SMTP_PORT),
    },
    linkTtlS: numberFrom(env.AUTH_LINK_TTL_S, 900),
    codeTtlS: numberFrom(env.AUTH_CODE_TTL_S, 120),
    accessTtlS: numberFrom(env.AUTH_ACCESS_TTL_S, 120),
    requestTtlS: numberFrom(env.AUTH_REQUEST_TTL_S, 900),
    sendWindowS: numberFrom(env.AUTH_SEND_WINDOW_S, 900),
    sendLimitPerEmail: numberFrom(env.AUTH_SEND_LIMIT_PER_EMAIL, 5),
    sendLimitPerIp: numberFrom(env.AUTH_SEND_LIMIT_PER_IP, 20),
    coreApiUrl: (env.CORE_API_URL ?? "http://localhost:8080").replace(/\/$/, ""),
    coreSigningSecret: env.CORE_SIGNING_SECRET,
  };
}

function validEmailDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

export function emailConfigured(cfg: AuthConfig): boolean {
  const credentials =
    cfg.transport === "resend" ? [cfg.resendApiKey] : [cfg.smtp.host, cfg.smtp.username, cfg.smtp.password];
  return [cfg.emailFrom, ...credentials].every((value) => Boolean(value.trim()));
}

function httpsUrlProblem(label: string, value: string, requireHttps: boolean): string | null {
  if (isMissingOrPlaceholder(value)) return `${label} is required and may not be a placeholder`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${label} must be an absolute URL`;
  }
  if (requireHttps && url.protocol !== "https:") return `${label} must be https in production`;
  if (url.search || url.hash) return `${label} must not carry a query string or fragment`;
  return null;
}

export function bootProblems(cfg: AuthConfig, isProd: boolean): string[] {
  const problems: string[] = [];
  const push = (problem: string | null): void => {
    if (problem) problems.push(problem);
  };

  push(httpsUrlProblem("AUTH_ISSUER", cfg.issuer, isProd));
  push(httpsUrlProblem("AUTH_REDIRECT_URI", cfg.redirectUri, isProd));
  if (isMissingOrPlaceholder(cfg.clientId)) problems.push("AUTH_CLIENT_ID is required and may not be a placeholder");
  if (isMissingOrPlaceholder(cfg.clientSecret))
    problems.push("AUTH_CLIENT_SECRET is required and may not be a placeholder");
  else if (cfg.clientSecret.trim().length < 32)
    problems.push(
      "AUTH_CLIENT_SECRET must be at least 32 characters — it is the portal's only credential at the token endpoint",
    );
  if (isMissingOrPlaceholder(cfg.tokenSecret))
    problems.push("AUTH_TOKEN_SECRET is required and may not be a placeholder");
  else if (cfg.tokenSecret.trim().length < 32) problems.push("AUTH_TOKEN_SECRET must be at least 32 characters");
  if (cfg.clientSecret && cfg.tokenSecret && cfg.clientSecret === cfg.tokenSecret) {
    problems.push("AUTH_CLIENT_SECRET must differ from AUTH_TOKEN_SECRET");
  }
  if (!cfg.signingJwk) problems.push("AUTH_SIGNING_JWK is required and must be a JSON Web Key object");
  else if (cfg.signingJwk.kty !== "EC" || cfg.signingJwk.crv !== "P-256" || typeof cfg.signingJwk.d !== "string") {
    problems.push("AUTH_SIGNING_JWK must be a P-256 private JSON Web Key (kty EC, crv P-256, with d)");
  }

  if (!cfg.allowedEmails.length && !cfg.allowedEmailDomain) {
    problems.push(
      "AUTH_ALLOWED_EMAILS or AUTH_ALLOWED_EMAIL_DOMAIN is required — without one, anybody with an inbox could sign in",
    );
  }
  const badEmail = cfg.allowedEmails.find((email) => !validEmail(email) || isMissingOrPlaceholder(email));
  if (badEmail)
    problems.push("AUTH_ALLOWED_EMAILS must be a comma-separated list of valid, non-placeholder email addresses");
  if (
    cfg.allowedEmailDomain &&
    (isMissingOrPlaceholder(cfg.allowedEmailDomain) || !validEmailDomain(cfg.allowedEmailDomain))
  ) {
    problems.push("AUTH_ALLOWED_EMAIL_DOMAIN must be a valid, non-placeholder email domain when set");
  }

  if (emailConfigured(cfg)) {
    if (isMissingOrPlaceholder(cfg.emailFrom) || !validEmail(senderAddress(cfg.emailFrom))) {
      problems.push('AUTH_EMAIL_FROM must be a verified sender address, optionally as "Name <sender@example.com>"');
    }
    if (cfg.transport === "resend") {
      if (isMissingOrPlaceholder(cfg.resendApiKey))
        problems.push("RESEND_API_KEY is required when AUTH_EMAIL_TRANSPORT is resend");
    } else {
      if (isMissingOrPlaceholder(cfg.smtp.host))
        problems.push("SMTP_HOST is required when AUTH_EMAIL_TRANSPORT is smtp");
      if (isMissingOrPlaceholder(cfg.smtp.username))
        problems.push("SMTP_USERNAME is required when AUTH_EMAIL_TRANSPORT is smtp");
      if (isMissingOrPlaceholder(cfg.smtp.password))
        problems.push("SMTP_PASSWORD is required when AUTH_EMAIL_TRANSPORT is smtp");
      if (!Number.isInteger(cfg.smtp.port) || cfg.smtp.port < 1 || cfg.smtp.port > 65535)
        problems.push("SMTP_PORT must be a TCP port number");
      if (isProd && cfg.smtp.tls === "none")
        problems.push(
          "SMTP_TLS=none may not be used in production — SMTP credentials would cross the network in cleartext",
        );
    }
  }

  if (isProd && isMissingOrPlaceholder(cfg.coreSigningSecret)) {
    problems.push(
      "CORE_SIGNING_SECRET is required — single-use enforcement for links and codes is durable state held by core",
    );
  }
  if (cfg.linkTtlS > 3600) problems.push("AUTH_LINK_TTL_S must be at most 3600 seconds");
  if (cfg.codeTtlS > 600) problems.push("AUTH_CODE_TTL_S must be at most 600 seconds");
  if (cfg.accessTtlS > 600) problems.push("AUTH_ACCESS_TTL_S must be at most 600 seconds");
  if (cfg.requestTtlS > 3600) problems.push("AUTH_REQUEST_TTL_S must be at most 3600 seconds");
  if (cfg.sendWindowS > 3600) problems.push("AUTH_SEND_WINDOW_S must be at most 3600 seconds");
  for (const [name, limit] of [
    ["AUTH_SEND_LIMIT_PER_EMAIL", cfg.sendLimitPerEmail],
    ["AUTH_SEND_LIMIT_PER_IP", cfg.sendLimitPerIp],
  ] as const) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RATE_LIMIT_SLOTS) {
      problems.push(
        `${name} must be a whole number between 1 and ${MAX_RATE_LIMIT_SLOTS} — each unit is one durable claim slot`,
      );
    }
  }
  return problems;
}

export function senderAddress(from: string): string {
  const angled = /<([^>]+)>\s*$/.exec(from.trim());
  return (angled?.[1] ?? from).trim();
}
