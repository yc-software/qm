import { createHash } from "node:crypto";
import { HARBOUR_STYLE, harbourScene } from "../../chassis/src/harbour.ts";
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
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const CONFIRM_PAGE_CSP = PAGE_CSP.replace(
  "default-src 'none';",
  `default-src 'none'; script-src '${CONFIRM_SCRIPT_HASH}';`,
);

const STYLE = `${HARBOUR_STYLE}
<style>
  .card form{ display:grid; gap:10px; margin:0; }
  .card h1 + .actions{ margin-top:16px; }
  .card label{ font-size:11px; font-weight:600; color:var(--muted); }
  .card input[type=email],.card input[type=password]{ width:100%; padding:11px 14px; font:inherit; font-size:12px;
    color:var(--ink); background:#fdfdfb; border:1px solid var(--line); border-radius:7px; }
  .card input[type=email]:focus-visible,.card input[type=password]:focus-visible{ outline:2px solid #8394a0; outline-offset:3px; }
  .card .btn{ border:none; background:var(--ink); color:#fff; }
  .card .btn::after{ content:"→"; font-size:19px; line-height:16px; }
  .card .btn:hover{ background:#29445b; }
  .card .btn.alternative{ border:1px solid var(--line); background:#fdfdfb; color:var(--ink); }
  .card .btn.alternative::after{ color:var(--muted); }
  .card .btn.alternative:hover{ background:#fff; }
  .card .btn.alternative:hover::after{ color:var(--ink); }
  .divider{ display:flex; align-items:center; gap:12px; margin:16px 0; color:var(--muted); font-size:10px; font-weight:600; letter-spacing:.08em; }
  .divider::before,.divider::after{ content:""; flex:1; height:1px; background:var(--line); }
  .note{ color:var(--muted); font-size:11px; line-height:1.5; margin:4px 0 0; }
  .who{ display:block; margin:0 0 16px; font-size:12px; color:var(--ink); background:#fdfdfb;
    border:1px solid var(--line); border-radius:7px; padding:10px 12px; word-break:break-word; }
</style>`;

const SENT_ICON = `<svg viewBox="0 0 24 24"><path d="M21 4 3 11l7 3 3 7z"/><path d="M21 4 10 14"/></svg>`;
const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

const wordmark = (brandName: string): string => (brandName === "qm" ? "QM" : brandName);

function page(o: {
  title: string;
  brandName: string;
  trustedSignInLabel?: string;
  icon?: string;
  warn?: boolean;
  heading: string;
  msg?: string;
  body?: string;
  help?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(o.title)} · ${escapeHtml(wordmark(o.brandName))}</title>
${STYLE}
</head>
<body>
  <main>
    ${harbourScene(wordmark(o.brandName))}
    <section class="card" aria-labelledby="t">
      ${o.icon ? `<div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">${o.icon}</div>` : ""}
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      ${o.msg ? `<p class="msg">${escapeHtml(o.msg)}</p>` : ""}
      ${o.body ?? ""}
      ${o.help ? `<p class="help">${escapeHtml(o.help)}</p>` : ""}
      ${o.trustedSignInLabel ? `<div class="divider">OR</div><a class="btn alternative" href="/auth/trusted/login">Sign in with ${escapeHtml(o.trustedSignInLabel)}</a>` : ""}
    </section>
  </main>
</body>
</html>`;
}

export function signInPage(o: {
  brandName: string;
  trustedSignInLabel?: string;
  action: string;
  requestToken: string;
  emailLink: boolean;
  password: boolean;
  email?: string;
  problem?: string;
  passwordProblem?: string;
}): string {
  const hidden = `<input type="hidden" name="request" value="${escapeHtml(o.requestToken)}">`;
  const trustedButton = o.trustedSignInLabel
    ? `<a class="btn" href="/auth/trusted/login">Sign in with ${escapeHtml(o.trustedSignInLabel)}</a>`
    : "";
  if (trustedButton && !o.emailLink && !o.password) {
    return page({
      title: "Sign in",
      brandName: o.brandName,
      heading: `Sign in to ${wordmark(o.brandName)}`,
      msg: "Your team's conversations, connections and scheduled work are waiting.",
      body: `<div class="actions">${trustedButton.replace('class="btn"', 'class="btn alternative"')}</div>`,
    });
  }
  const trusted = trustedButton ? `${trustedButton}<div class="divider">OR</div>` : "";
  const secondary = Boolean(o.trustedSignInLabel) || (o.emailLink && o.password);
  const emailForm = o.emailLink
    ? `${o.problem ? `<p class="reason"><strong>Try again</strong>${escapeHtml(o.problem)}</p>` : ""}<form method="post" action="${escapeHtml(o.action)}">
        ${hidden}
        <input type="hidden" name="method" value="email">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required${secondary ? "" : " autofocus"}
          spellcheck="false" maxlength="254" placeholder="you@example.com" value="${escapeHtml(o.email ?? "")}">
        <button class="btn${secondary ? " alternative" : ""}" type="submit">Email me a sign-in link</button>
      </form>`
    : "";
  const passwordForm = o.password
    ? `${o.passwordProblem ? `<p class="reason"><strong>Try again</strong>${escapeHtml(o.passwordProblem)}</p>` : ""}<form method="post" action="${escapeHtml(o.action)}">
        ${hidden}
        <input type="hidden" name="method" value="password">
        <label for="password-email">Email address</label>
        <input id="password-email" name="email" type="email" autocomplete="username" inputmode="email" required${o.trustedSignInLabel ? "" : " autofocus"}
          spellcheck="false" maxlength="254" placeholder="you@example.com" value="${escapeHtml(o.email ?? "")}">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
        <button class="btn${o.trustedSignInLabel ? " alternative" : ""}" type="submit">Sign in with password</button>
        <p class="note">Password sign-in is meant for getting started. Once ${escapeHtml(wordmark(o.brandName))} is set up, your administrator should switch to email links or an identity provider.</p>
      </form>`
    : "";
  let msg = "Enter your work email and we'll send you a one-time sign-in link.";
  if (o.trustedSignInLabel) msg = `Use your ${o.trustedSignInLabel} account to continue.`;
  else if (o.password && o.emailLink) msg = "Sign in with your password, or have a one-time link emailed to you.";
  else if (o.password) msg = "Enter the email address and password your administrator gave you.";
  return page({
    title: "Sign in",
    brandName: o.brandName,
    heading: `Sign in to ${wordmark(o.brandName)}`,
    msg,
    body: `${trusted}${passwordForm}${o.password && o.emailLink ? `<div class="divider">OR</div>` : ""}${emailForm}`,
    help: o.emailLink
      ? "For email sign-in, use an address your administrator has allowed."
      : "Use the account your administrator has allowed.",
  });
}

export function linkSentPage(o: {
  brandName: string;
  trustedSignInLabel?: string;
  email: string;
  ttlMinutes: number;
}): string {
  return page({
    title: "Check your email",
    brandName: o.brandName,
    trustedSignInLabel: o.trustedSignInLabel,
    icon: SENT_ICON,
    heading: "Check your email",
    msg: `If that address can sign in, a one-time link is on its way. Open it in this browser. It works once and expires in ${o.ttlMinutes} minutes.`,
    body: `<p class="who">${escapeHtml(o.email)}</p>`,
    help: "Nothing after a minute or two? Check spam, then ask your administrator whether the address is allowed.",
  });
}

export function confirmSignInPage(o: { brandName: string; trustedSignInLabel?: string; action: string }): string {
  return page({
    title: "Finish signing in",
    brandName: o.brandName,
    trustedSignInLabel: o.trustedSignInLabel,
    icon: LOCK_ICON,
    heading: `Finish signing in to ${wordmark(o.brandName)}`,
    msg: "Confirm below to complete sign-in. Your link is spent the moment you confirm, so do it in the browser you want to be signed in to.",
    body: `<p class="reason" id="no-token" hidden><strong>Nothing to confirm</strong>This page did not receive a sign-in link. Open the link from your email directly, in a browser with JavaScript enabled, or ask for a fresh one.</p>
      <noscript><p class="reason"><strong>JavaScript required</strong>The last step of sign-in reads your link out of the page address so it never reaches a server log. Enable JavaScript for this page, then reopen the link.</p></noscript>
      <form method="post" action="${escapeHtml(o.action)}">
        <input type="hidden" name="token" id="token" value="">
        <button class="btn" type="submit" id="confirm">Sign in</button>
      </form>
      <script>${CONFIRM_SCRIPT}</script>`,
    help: "Didn't ask to sign in? Close this page. Nothing happens until you confirm.",
  });
}

export function problemPage(o: {
  brandName: string;
  trustedSignInLabel?: string;
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
    trustedSignInLabel: o.trustedSignInLabel,
    icon: ALERT_ICON,
    warn: true,
    heading: o.heading,
    msg: o.msg,
    ...(body ? { body } : {}),
    help: "If this keeps happening, contact your administrator.",
  });
}
