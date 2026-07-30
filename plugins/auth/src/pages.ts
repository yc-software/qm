import { createHash } from "node:crypto";
import { escapeHtml } from "../../chassis/src/http.ts";

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
</style>`;

const MAIL_ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`;
const SENT_ICON = `<svg viewBox="0 0 24 24"><path d="M21 4 3 11l7 3 3 7z"/><path d="M21 4 10 14"/></svg>`;
const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

function page(o: {
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
<html lang="en">
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
  brandName: string;
  action: string;
  requestToken: string;
  email?: string;
  problem?: string;
}): string {
  return page({
    title: "Sign in",
    brandName: o.brandName,
    icon: MAIL_ICON,
    heading: `Sign in to ${o.brandName}`,
    msg: "Enter your work email and we'll send you a one-time sign-in link.",
    body: `${o.problem ? `<p class="reason"><strong>Try again</strong>${escapeHtml(o.problem)}</p>` : ""}<form method="post" action="${escapeHtml(o.action)}">
        <input type="hidden" name="request" value="${escapeHtml(o.requestToken)}">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus
          spellcheck="false" maxlength="254" placeholder="you@example.com" value="${escapeHtml(o.email ?? "")}">
        <button class="btn" type="submit">Email me a sign-in link</button>
      </form>`,
    help: "Only addresses your administrator has allowed can sign in.",
  });
}

export function linkSentPage(o: { brandName: string; email: string; ttlMinutes: number }): string {
  return page({
    title: "Check your email",
    brandName: o.brandName,
    icon: SENT_ICON,
    heading: "Check your email",
    msg: `If that address can sign in, a one-time link is on its way. Open it in this browser — it works once and expires in ${o.ttlMinutes} minutes.`,
    body: `<p class="who">${escapeHtml(o.email)}</p>`,
    help: "Nothing after a minute or two? Check spam, then ask your administrator whether the address is allowed.",
  });
}

export function confirmSignInPage(o: { brandName: string; action: string }): string {
  return page({
    title: "Finish signing in",
    brandName: o.brandName,
    icon: LOCK_ICON,
    heading: `Finish signing in to ${o.brandName}`,
    msg: "Confirm below to complete sign-in. Your link is spent the moment you confirm, so do it in the browser you want to be signed in to.",
    body: `<p class="reason" id="no-token" hidden><strong>Nothing to confirm</strong>This page did not receive a sign-in link. Open the link from your email directly, in a browser with JavaScript enabled, or ask for a fresh one.</p>
      <noscript><p class="reason"><strong>JavaScript required</strong>The last step of sign-in reads your link out of the page address so it never reaches a server log. Enable JavaScript for this page, then reopen the link.</p></noscript>
      <form method="post" action="${escapeHtml(o.action)}">
        <input type="hidden" name="token" id="token" value="">
        <button class="btn" type="submit" id="confirm">Sign in</button>
      </form>
      <script>${CONFIRM_SCRIPT}</script>`,
    help: "Didn't ask to sign in? Close this page — nothing happens until you confirm.",
  });
}

export function problemPage(o: {
  brandName: string;
  heading: string;
  msg: string;
  detail?: string;
  retryUrl?: string;
}): string {
  const detail = o.detail ? `<p class="reason"><strong>Details</strong>${escapeHtml(o.detail)}</p>` : "";
  const retry = o.retryUrl ? `<a class="btn" href="${escapeHtml(o.retryUrl)}">Request a new sign-in link</a>` : "";
  const body = `${detail}${retry}`;
  return page({
    title: "Sign-in problem",
    brandName: o.brandName,
    icon: ALERT_ICON,
    warn: true,
    heading: o.heading,
    msg: o.msg,
    ...(body ? { body } : {}),
    help: "If this keeps happening, contact your administrator.",
  });
}
