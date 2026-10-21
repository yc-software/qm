import { createTransport } from "nodemailer";
import { escapeHtml } from "../../chassis/src/http.ts";
import { resendMailer, type Mailer, type OutgoingEmail } from "../../chassis/src/resend.ts";
import { emailConfigured, type AuthConfig } from "./config.ts";

const SMTP_TIMEOUT_MS = 15_000;

function smtpMailer(cfg: AuthConfig): Mailer {
  const { host, port, username, password, tls } = cfg.smtp;
  const transport = createTransport({
    host,
    port,
    secure: tls === "implicit",
    requireTLS: tls === "starttls",
    ignoreTLS: tls === "none",
    auth: { user: username, pass: password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return {
    async send(message) {
      const info = await transport.sendMail({
        from: cfg.emailFrom,
        ...message,
        textEncoding: "base64",
        headers: { "Auto-Submitted": "auto-generated" },
      });
      return info.response;
    },
  };
}

export function mailerFor(cfg: AuthConfig): Mailer | null {
  if (!emailConfigured(cfg)) return null;
  return cfg.transport === "smtp" ? smtpMailer(cfg) : resendMailer(cfg.resendApiKey, cfg.emailFrom);
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
