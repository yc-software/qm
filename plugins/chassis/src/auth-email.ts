export type AuthEmailTransport = "smtp" | "resend";
export type AuthEmailAccess = { mode: "emails"; emails: string[] } | { mode: "domain"; domain: string };
export type SmtpTlsMode = "implicit" | "starttls" | "none";

interface AuthEmailBase {
  from: string;
  access: AuthEmailAccess;
}

export interface SmtpAuthEmailSettings extends AuthEmailBase {
  transport: "smtp";
  smtp: {
    host: string;
    port: number;
    tls: SmtpTlsMode;
    username: string;
    password: string;
  };
}

export interface ResendAuthEmailSettings extends AuthEmailBase {
  transport: "resend";
  resend: { apiKey: string };
}

export type AuthEmailSettings = SmtpAuthEmailSettings | ResendAuthEmailSettings;

export function senderAddress(from: string): string {
  const angled = /<([^>]+)>\s*$/.exec(from.trim());
  return (angled?.[1] ?? from).trim().toLowerCase();
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

export function validEmailDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
}

export function emailAllowed(settings: Pick<AuthEmailSettings, "access">, rawEmail: string): boolean {
  const email = rawEmail.trim().toLowerCase();
  return settings.access.mode === "emails"
    ? settings.access.emails.includes(email)
    : email.endsWith(`@${settings.access.domain}`);
}

export function authEmailProblems(settings: AuthEmailSettings, production: boolean): string[] {
  const problems: string[] = [];
  if (!validEmail(senderAddress(settings.from))) problems.push("from must contain a valid sender email address");
  if (settings.access.mode === "emails") {
    if (!settings.access.emails.length || settings.access.emails.some((email) => !validEmail(email))) {
      problems.push("access.emails must contain at least one valid email address");
    }
  } else if (!validEmailDomain(settings.access.domain)) {
    problems.push("access.domain must be a valid email domain");
  }
  if (settings.transport === "smtp") {
    if (!settings.smtp.host) problems.push("smtp.host is required");
    if (!Number.isInteger(settings.smtp.port) || settings.smtp.port < 1 || settings.smtp.port > 65535) {
      problems.push("smtp.port must be a TCP port number");
    }
    if (!settings.smtp.username) problems.push("smtp.username is required");
    if (!settings.smtp.password) problems.push("smtp.password is required");
    if (production && settings.smtp.tls === "none") problems.push("smtp.tls may not be none in production");
  } else if (!settings.resend.apiKey) {
    problems.push("resend.apiKey is required");
  }
  return problems;
}

export function normalizeAuthEmailSettings(settings: AuthEmailSettings): AuthEmailSettings {
  const access: AuthEmailAccess =
    settings.access.mode === "emails"
      ? {
          mode: "emails",
          emails: [...new Set(settings.access.emails.map((email) => email.trim().toLowerCase()).filter(Boolean))],
        }
      : { mode: "domain", domain: settings.access.domain.trim().toLowerCase().replace(/^@/, "") };
  if (settings.transport === "smtp") {
    return {
      transport: "smtp",
      from: settings.from.trim(),
      access,
      smtp: {
        host: settings.smtp.host.trim(),
        port: settings.smtp.port,
        tls: settings.smtp.tls,
        username: settings.smtp.username.trim(),
        password: settings.smtp.password,
      },
    };
  }
  return {
    transport: "resend",
    from: settings.from.trim(),
    access,
    resend: { apiKey: settings.resend.apiKey },
  };
}
