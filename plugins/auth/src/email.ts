import { createTransport } from "nodemailer";
import { escapeHtml } from "../../chassis/src/http.ts";
import { emailConfigured, senderAddress, type AuthConfig } from "./config.ts";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: OutgoingEmail): Promise<string>;
  verify(): Promise<string>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_VERIFY_ENDPOINT = "https://api.resend.com/domains";
const RESEND_TIMEOUT_MS = 15_000;
const SMTP_TIMEOUT_MS = 15_000;

export function resendMailer(cfg: AuthConfig, fetchImpl: typeof fetch = fetch): Mailer {
  const authorization = `Bearer ${cfg.resendApiKey}`;
  return {
    async send(message) {
      const r = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          from: cfg.emailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!r.ok)
        throw new Error(`Resend rejected the message: HTTP ${r.status} ${body.message ?? body.name ?? ""}`.trim());
      return body.id ?? "accepted";
    },
    async verify() {
      const r = await fetchImpl(RESEND_VERIFY_ENDPOINT, {
        headers: { authorization },
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (r.status === 401 || r.status === 403) throw new Error("Resend rejected RESEND_API_KEY");
      if (!r.ok) throw new Error(`Resend API returned HTTP ${r.status}`);
      return "Resend API key accepted";
    },
  };
}

function clientName(host: string): string {
  return /^[A-Za-z0-9.-]+$/.test(host) ? host : "localhost";
}

function senderOf(from: string): { name: string; address: string } {
  const bracket = from.lastIndexOf("<");
  const name =
    bracket === -1
      ? ""
      : from
          .slice(0, bracket)
          .trim()
          .replace(/^"(.*)"$/, "$1");
  return { name, address: senderAddress(from) };
}

function smtpMailer(cfg: AuthConfig): Mailer {
  const { host, port, username, password, tls } = cfg.smtp;
  const transporter = createTransport({
    host,
    port,
    secure: tls === "implicit",
    requireTLS: tls === "starttls",
    ignoreTLS: tls === "none",
    name: clientName(host),
    auth: username || password ? { user: username, pass: password } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(message) {
      const info = await transporter.sendMail({
        from: senderOf(cfg.emailFrom),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        textEncoding: "base64",
        headers: { "Auto-Submitted": "auto-generated" },
      });
      return info.response ?? "accepted";
    },
    async verify() {
      await transporter.verify();
      return `SMTP ${host}:${port} authenticated`;
    },
  };
}

export function mailerFor(cfg: AuthConfig): Mailer | null {
  if (!emailConfigured(cfg)) return null;
  return cfg.transport === "smtp" ? smtpMailer(cfg) : resendMailer(cfg);
}

export function renderSignInEmail(args: {
  to: string;
  brandName: string;
  link: string;
  ttlMinutes: number;
}): OutgoingEmail {
  const link = args.link;
  const brand = args.brandName;
  const text = [
    `Sign in to ${brand}`,
    "",
    "Open this link to finish signing in:",
    link,
    "",
    `The link works once and expires in ${args.ttlMinutes} minutes. Open it in the browser you started from.`,
    "If you did not ask to sign in, ignore this message. Nothing happens until you confirm.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f5f5f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a">
<tr><td>
<h1 style="margin:0 0 10px;font-size:20px;font-weight:600">Sign in to ${escapeHtml(brand)}</h1>
<p style="margin:0 0 24px;color:#525252">Use the button below to finish signing in. It works once, expires in ${args.ttlMinutes} minutes, and should be opened in the browser you started from.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:10px">Sign in</a></p>
<p style="margin:0 0 8px;color:#737373;font-size:13px">Or paste this address into your browser:</p>
<p style="margin:0 0 24px;word-break:break-all;font-size:12px;color:#525252">${escapeHtml(link)}</p>
<p style="margin:0;color:#737373;font-size:13px">If you did not ask to sign in, ignore this message. Nothing happens until you confirm.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { to: args.to, subject: `Sign in to ${brand}`, text, html };
}
