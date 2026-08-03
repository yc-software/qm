import { createHash } from "node:crypto";
import { escapeHtml } from "../../chassis/src/http.ts";
import type { Locale } from "../../chassis/src/locale.ts";
import { authMessage } from "./messages.ts";

const CONFIRM_SCRIPT = `(function () {
  var key = "qm.signin.token";
  var fragment = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fragment) {
    try { sessionStorage.setItem(key, fragment); } catch (e) { void e; }
    history.replaceState(null, "", location.pathname);
  }
  var token = fragment;
  if (!token) { try { token = sessionStorage.getItem(key); } catch (e) { void e; } }
  if (token) { document.getElementById("token").value = token; return; }
  document.getElementById("confirm").disabled = true;
  document.getElementById("no-token").hidden = false;
})();`;

const CONFIRM_SCRIPT_HASH = `sha256-${createHash("sha256").update(CONFIRM_SCRIPT, "utf8").digest("base64")}`;

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const CONFIRM_PAGE_CSP = PAGE_CSP.replace(
  "default-src 'none';",
  `default-src 'none'; script-src '${CONFIRM_SCRIPT_HASH}';`,
);

const STYLE = `<style>
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
  .icon{ width:52px; height:52px; margin:0 auto 18px; border-radius:var(--radius-md); background:var(--secondary);
    display:grid; place-items:center; }
  .icon svg{ width:26px; height:26px; stroke:var(--text); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn{ background:var(--warn-bg); }
  .icon.warn svg{ stroke:var(--warn); stroke-width:2; }
  h1{ font-size:20px; font-weight:600; margin:0 0 8px; }
  .msg{ color:var(--muted); margin:0 auto 22px; max-width:40ch; font-size:14px; }
  .reason{ margin:0 auto 22px; font-size:13px; color:var(--text);
    background:var(--warn-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px;
    text-align:left; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  form{ display:grid; gap:10px; text-align:left; }
  label{ font-size:12.5px; font-weight:600; color:var(--muted); }
  input[type=email]{ width:100%; min-height:44px; padding:0 14px; font:inherit; color:var(--text);
    background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-md); }
  input[type=email]:focus-visible{ outline:2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset:1px; }
  .btn{ display:flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px; width:100%;
    text-decoration:none; font:inherit; font-weight:600; border-radius:var(--radius-md); cursor:pointer;
    background:var(--text); color:var(--bg); border:1px solid var(--text); }
  .btn:hover{ opacity:.9; }
  .help{ color:var(--muted); font-size:12.5px; margin:20px 0 0; }
  .who{ display:block; margin:0 auto 22px; font-size:13px; color:var(--text); background:var(--secondary);
    border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px; word-break:break-word; }
  .language-form{ margin-top:22px; padding-top:18px; border-top:1px solid var(--border);
    grid-template-columns:1fr auto; align-items:end; }
  .language-form label{ grid-column:1/-1; }
  .language-form select{ min-height:38px; padding:0 10px; font:inherit; color:var(--text); background:var(--bg);
    border:1px solid var(--border); border-radius:var(--radius-md); }
  .language-form button{ min-height:38px; padding:0 14px; font:inherit; font-weight:600; color:var(--text);
    background:var(--secondary); border:1px solid var(--border); border-radius:var(--radius-md); cursor:pointer; }
</style>`;

const MAIL_ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;
const SENT_ICON = `<svg viewBox="0 0 24 24"><path d="M21 4 3 11l7 3 3 7z"/><path d="M21 4 10 14"/></svg>`;
const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

function page(o: {
  locale: Locale;
  title: string;
  brandName: string;
  icon: string;
  warn?: boolean;
  heading: string;
  msg: string;
  body?: string;
  help: string;
}): string {
  return `<!doctype html>
<html lang="${o.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(o.title)} · ${escapeHtml(o.brandName)}</title>
${STYLE}
</head>
<body>
  <main>
    <section class="card" aria-labelledby="t">
      <div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">${o.icon}</div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      <p class="msg">${escapeHtml(o.msg)}</p>
      ${o.body ?? ""}
      <p class="help">${escapeHtml(o.help)}</p>
    </section>
  </main>
</body>
</html>`;
}

export function emailFormPage(o: {
  locale: Locale;
  brandName: string;
  action: string;
  returnTo: string;
  requestToken: string;
  email?: string;
  problem?: string;
}): string {
  return page({
    locale: o.locale,
    title: authMessage(o.locale, "signIn.title"),
    brandName: o.brandName,
    icon: MAIL_ICON,
    heading: authMessage(o.locale, "signIn.heading", { brand: o.brandName }),
    msg: authMessage(o.locale, "signIn.message"),
    body: `${o.problem ? `<p class="reason"><strong>${escapeHtml(authMessage(o.locale, "signIn.tryAgain"))}</strong>${escapeHtml(o.problem)}</p>` : ""}<form method="post" action="${escapeHtml(o.action)}">
        <input type="hidden" name="request" value="${escapeHtml(o.requestToken)}">
        <label for="email">${escapeHtml(authMessage(o.locale, "signIn.emailLabel"))}</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus
          spellcheck="false" maxlength="254" placeholder="${escapeHtml(authMessage(o.locale, "signIn.emailPlaceholder"))}" value="${escapeHtml(o.email ?? "")}">
        <button class="btn" type="submit">${escapeHtml(authMessage(o.locale, "signIn.submit"))}</button>
      </form>
      <form id="language-form" action="/locale" method="post" class="language-form">
        <input type="hidden" name="returnTo" value="${escapeHtml(o.returnTo)}">
        <label for="locale">${escapeHtml(authMessage(o.locale, "language.label"))}</label>
        <select id="locale" name="locale">
          <option value="en"${o.locale === "en" ? " selected" : ""}>${escapeHtml(authMessage(o.locale, "language.english"))}</option>
          <option value="ja"${o.locale === "ja" ? " selected" : ""}>${escapeHtml(authMessage(o.locale, "language.japanese"))}</option>
        </select>
        <button type="submit">${escapeHtml(authMessage(o.locale, "language.change"))}</button>
      </form>`,
    help: authMessage(o.locale, "signIn.help"),
  });
}

export function linkSentPage(o: { locale: Locale; brandName: string; email: string; ttlMinutes: number }): string {
  return page({
    locale: o.locale,
    title: authMessage(o.locale, "sent.title"),
    brandName: o.brandName,
    icon: SENT_ICON,
    heading: authMessage(o.locale, "sent.heading"),
    msg: authMessage(o.locale, "sent.message", { minutes: o.ttlMinutes }),
    body: `<p class="who">${escapeHtml(o.email)}</p>`,
    help: authMessage(o.locale, "sent.help"),
  });
}

export function confirmSignInPage(o: { locale: Locale; brandName: string; action: string }): string {
  return page({
    locale: o.locale,
    title: authMessage(o.locale, "confirm.title"),
    brandName: o.brandName,
    icon: LOCK_ICON,
    heading: authMessage(o.locale, "confirm.heading", { brand: o.brandName }),
    msg: authMessage(o.locale, "confirm.message"),
    body: `<p class="reason" id="no-token" hidden><strong>${escapeHtml(authMessage(o.locale, "confirm.missingTitle"))}</strong>${escapeHtml(authMessage(o.locale, "confirm.missingBody"))}</p>
      <noscript><p class="reason"><strong>${escapeHtml(authMessage(o.locale, "confirm.javascriptTitle"))}</strong>${escapeHtml(authMessage(o.locale, "confirm.javascriptBody"))}</p></noscript>
      <form method="post" action="${escapeHtml(o.action)}">
        <input type="hidden" name="token" id="token" value="">
        <button class="btn" type="submit" id="confirm">${escapeHtml(authMessage(o.locale, "confirm.submit"))}</button>
      </form>
      <script>${CONFIRM_SCRIPT}</script>`,
    help: authMessage(o.locale, "confirm.help"),
  });
}

export function problemPage(o: {
  locale: Locale;
  brandName: string;
  heading: string;
  msg: string;
  detail?: string;
  retryUrl?: string;
}): string {
  const detail = o.detail
    ? `<p class="reason"><strong>${escapeHtml(authMessage(o.locale, "problem.details"))}</strong>${escapeHtml(o.detail)}</p>`
    : "";
  const retry = o.retryUrl
    ? `<a class="btn" href="${escapeHtml(o.retryUrl)}">${escapeHtml(authMessage(o.locale, "problem.retry"))}</a>`
    : "";
  const body = `${detail}${retry}`;
  return page({
    locale: o.locale,
    title: authMessage(o.locale, "problem.title"),
    brandName: o.brandName,
    icon: ALERT_ICON,
    warn: true,
    heading: o.heading,
    msg: o.msg,
    ...(body ? { body } : {}),
    help: authMessage(o.locale, "problem.help"),
  });
}
