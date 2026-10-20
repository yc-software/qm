import { escapeHtml } from "../../plugins/chassis/src/http.ts";

export const INVITE_EMAIL_NOT_CONFIGURED =
  "invitation emails are not configured — set RESEND_API_KEY and AUTH_EMAIL_FROM on core (the same Resend key and verified sender the sign-in broker uses)";

export function renderInviteEmail(a: {
  to: string;
  brandName: string;
  invitedBy: string;
  signInUrl: string;
  expiresAt: number | null;
  magicLink?: boolean;
}): { subject: string; text: string; html: string } {
  const access =
    a.expiresAt === null
      ? "Your access has no expiration date."
      : `Your access ends on ${new Date(a.expiresAt).toUTCString()}.`;
  const instruction = a.magicLink
    ? "Use this single-use link to sign in. The link is valid for 24 hours."
    : `Sign in using this email address (${a.to}).`;
  const subject = `You've been invited to ${a.brandName}`;
  const text = [
    subject,
    "",
    `${a.invitedBy} invited you to ${a.brandName}.`,
    "",
    `${instruction} ${a.signInUrl}`,
    "",
    access,
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f5f5f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a">
<tr><td>
<h1 style="margin:0 0 10px;font-size:20px;font-weight:600">${escapeHtml(subject)}</h1>
<p style="margin:0 0 24px;color:#525252">${escapeHtml(a.invitedBy)} invited you to ${escapeHtml(a.brandName)}. ${escapeHtml(instruction)}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(a.signInUrl)}" style="display:inline-block;background:#0a0a0a;color:#ffffff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:10px">Sign in</a></p>
<p style="margin:0 0 8px;color:#737373;font-size:13px">Or paste this address into your browser:</p>
<p style="margin:0 0 24px;word-break:break-all;font-size:12px;color:#525252">${escapeHtml(a.signInUrl)}</p>
<p style="margin:0;color:#737373;font-size:13px">${escapeHtml(access)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}
