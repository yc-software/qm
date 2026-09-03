import { escapeHtml } from "../api/http.ts";

export interface InviteMailer {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<string>;
}

export const INVITE_EMAIL_NOT_CONFIGURED =
  "invitation emails are not configured — set RESEND_API_KEY and AUTH_EMAIL_FROM on core (the same Resend key and verified sender the sign-in broker uses)";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 15_000;

export function createResendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): InviteMailer {
  return {
    async send(message) {
      const r = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
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
  };
}

export function renderInviteEmail(a: {
  to: string;
  brandName: string;
  invitedBy: string;
  signInUrl: string;
  expiresAt: number;
}): { subject: string; text: string; html: string } {
  const ends = new Date(a.expiresAt).toUTCString();
  const subject = `You've been invited to ${a.brandName}`;
  const text = [
    subject,
    "",
    `${a.invitedBy} invited you to ${a.brandName}.`,
    "",
    `Sign in at ${a.signInUrl} using this email address (${a.to}) — a one-time link is emailed to you at sign-in.`,
    "",
    `Your access ends on ${ends}.`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f5f5f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a">
<tr><td>
<h1 style="margin:0 0 10px;font-size:20px;font-weight:600">${escapeHtml(subject)}</h1>
<p style="margin:0 0 24px;color:#525252">${escapeHtml(a.invitedBy)} invited you to ${escapeHtml(a.brandName)}. Sign in using this email address (${escapeHtml(a.to)}) — a one-time link is emailed to you at sign-in.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(a.signInUrl)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:10px">Sign in</a></p>
<p style="margin:0 0 8px;color:#737373;font-size:13px">Or paste this address into your browser:</p>
<p style="margin:0 0 24px;word-break:break-all;font-size:12px;color:#525252">${escapeHtml(a.signInUrl)}</p>
<p style="margin:0;color:#737373;font-size:13px">Your access ends on ${escapeHtml(ends)}.</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}
