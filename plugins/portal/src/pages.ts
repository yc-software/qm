import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { escapeHtml, json } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";

let brandLabel = "QM";
export function setCardBrand(label: string): void {
  brandLabel = label.trim() || "QM";
}

export const CARD_SCENE_PATH = "/auth/assets/becalmed-off-halfway-rock.webp";
const CARD_SCENE_FILE = fileURLToPath(
  new URL("../../../desktop/assets/becalmed-off-halfway-rock.webp", import.meta.url),
);
let cardScene: Buffer | undefined;
export async function serveCardScene(res: ServerResponse): Promise<void> {
  try {
    cardScene ??= await readFile(CARD_SCENE_FILE);
    res.writeHead(200, { "content-type": "image/webp", "cache-control": "public, max-age=86400" });
    res.end(cardScene);
  } catch (error) {
    console.warn(`[portal] page background unavailable: ${errMessage(error)}`);
    json(res, 404, { error: "not_found" });
  }
}

const CARD_STYLE = `<style>
  :root{
    color-scheme:light;
    --paper:#f7f6f2; --ink:#1b3043; --muted:#6b706f; --line:#d6d9d9; --warn:#9d3927; --warn-bg:#f6e7e3;
    --brand-font:"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color:var(--ink); background:var(--paper); -webkit-font-smoothing:antialiased;
  }
  *{ box-sizing:border-box; }
  body{ margin:0; }
  main{ position:relative; min-height:100vh; isolation:isolate; padding:155px 24px 220px; }
  .harbour{ position:absolute; inset:0; z-index:-1; margin:0; overflow:hidden; background:#d8d0bd; }
  .harbour > img{ position:absolute; width:100%; height:100%; object-fit:cover; object-position:center 62%; }
  .masthead{ position:relative; padding:62px 52px 26px; }
  .wordmark{ font-family:var(--brand-font); font-size:40px; letter-spacing:-2px; line-height:1; }
  figcaption{ position:absolute; bottom:19px; right:28px; display:flex; gap:12px; font-size:9px; letter-spacing:.035em;
    color:#fffaf0; text-shadow:0 1px 5px #211c14; }
  figcaption span{ opacity:.85; }
  .card{ width:min(100%, 420px); margin-inline:auto; padding:28px; border:1px solid #fffaf080; border-radius:12px;
    background:rgb(247 246 242 / 88%); box-shadow:0 4px 24px rgb(37 38 31 / 5%); backdrop-filter:blur(12px);
    -webkit-backdrop-filter:blur(12px); }
  .icon{ display:flex; margin-bottom:12px; }
  .icon svg{ width:22px; height:22px; stroke:var(--ink); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn svg{ stroke:var(--warn); }
  h1{ font-size:15px; font-weight:600; margin:0 0 7px; }
  .msg{ font-size:12px; line-height:1.6; color:var(--muted); margin:0 0 16px; }
  .reason{ margin:0 0 16px; font-size:12px; line-height:1.5; color:var(--ink); background:var(--warn-bg);
    border:1px solid #e8cfc8; border-radius:7px; padding:10px 12px; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; font-weight:600; margin-bottom:3px; }
  #invite-status, #admin-email{ font-size:12px; color:var(--ink); margin:0 0 16px; }
  #invite-status:empty, #admin-email:empty{ display:none; }
  .actions{ display:grid; gap:10px; }
  .actions form{ display:grid; margin:0; }
  .btn{ display:flex; justify-content:space-between; align-items:center; width:100%; border-radius:7px; padding:12px 14px;
    font:inherit; font-size:12px; text-decoration:none; cursor:pointer; }
  .btn.primary{ border:none; background:var(--ink); color:#fff; }
  .btn.primary::after{ content:"→"; font-size:19px; line-height:16px; }
  .btn.primary:hover{ background:#29445b; }
  .btn.ghost{ border:1px solid var(--line); background:#fdfdfb; color:var(--ink); }
  .btn.ghost:hover{ background:#fff; }
  .btn:focus-visible{ outline:2px solid #8394a0; outline-offset:3px; }
  .btn:disabled{ opacity:.65; cursor:wait; }
  .help{ color:#78807f; font-size:10px; line-height:1.5; margin:13px 0 0; text-align:center; }
  @media (max-width:600px){
    main{ padding-top:130px; }
    .masthead{ padding-inline:28px; }
    .card{ padding:24px; }
    figcaption{ left:20px; right:auto; font-size:8px; }
  }
</style>`;

const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
export const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

export function cardPage(o: {
  title: string;
  heading: string;
  msg: string;
  icon: string;
  warn?: boolean;
  extra?: string;
  actions: string;
  help: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · ${escapeHtml(brandLabel)}</title>
${CARD_STYLE}
</head>
<body>
  <main>
    <figure class="harbour">
      <img src="${CARD_SCENE_PATH}" alt="Sailing ships resting on still, sunlit water in Becalmed off Halfway Rock by Fitz Henry Lane.">
      <header class="masthead"><span class="wordmark">${escapeHtml(brandLabel)}</span></header>
      <figcaption>Becalmed off Halfway Rock<span>Fitz Henry Lane, 1860</span></figcaption>
    </figure>
    <section class="card" aria-labelledby="t">
      <div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">
        ${o.icon}
      </div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      ${o.msg ? `<p class="msg">${escapeHtml(o.msg)}</p>` : ""}
      ${o.extra ?? ""}
      <div class="actions">
        ${o.actions}
      </div>
      ${o.help ? `<p class="help">${escapeHtml(o.help)}</p>` : ""}
    </section>
  </main>
</body>
</html>`;
}

export function signInErrorHtml(
  detail: string,
  retryPath: "/auth/login" | "/auth/trusted/login" = "/auth/login",
): string {
  return cardPage({
    title: "Sign-in failed",
    heading: "We couldn't sign you in",
    msg: "Your sign-in didn't complete. This is usually temporary. Trying again resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    extra: `<p class="reason"><strong>Details</strong>${escapeHtml(detail)}</p>`,
    actions: `<a class="btn primary" href="${retryPath}">Try signing in again</a>`,
    help: "Still stuck? Check that your account has access, then contact your admin.",
  });
}

export function notConfiguredHtml(): string {
  return cardPage({
    title: "Not set up yet",
    heading: "This deployment isn't set up yet",
    msg: "An admin still needs to finish setup by adding a model API key. Until then the assistant can't answer.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/">Try again</a>`,
    help: "Ask your admin to complete onboarding in Settings.",
  });
}

export function connectPage(o: { title: string; body: string; action?: string; icon?: string }): string {
  return cardPage({
    title: o.title,
    heading: o.title,
    msg: o.body,
    icon: o.icon ?? ALERT_ICON,
    warn: !o.icon,
    actions: o.action ?? "",
    help: "",
  });
}

function providerLabel(provider: string): string {
  if (provider === "google") return "Google";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "this app";
}

export function connectErrorHtml(detail: string): string {
  return connectPage({ title: "Can't connect", body: detail });
}

export function connectWrongRecipientHtml(o: { provider: string; alreadyConnected: boolean }): string {
  const prov = providerLabel(o.provider);
  if (o.alreadyConnected) {
    return connectPage({
      title: `You've already connected ${prov}`,
      body: `This link was meant for a different teammate, and your ${prov} is already connected, so there's nothing to do here.`,
      action: `<a class="btn ghost" href="/connectors">Manage your connections</a>`,
      icon: LOCK_ICON,
    });
  }
  return connectPage({
    title: "This link was for someone else",
    body: `This connect link was created for a different teammate. Want to connect your own ${prov} instead?`,
    action: `<a class="btn primary" href="/connect/${encodeURIComponent(o.provider)}/self-connect">Connect my ${escapeHtml(prov)}</a>`,
    icon: LOCK_ICON,
  });
}

export function playgroundBusyHtml(): string {
  return cardPage({
    title: "Playground is busy",
    heading: "The playground is busy",
    msg: "We couldn't start a fresh playground session for you right now. Waiting a little while and reloading resolves most cases.",
    icon: ALERT_ICON,
    warn: true,
    actions: `<a class="btn primary" href="/">Try again</a>`,
    help: "Playground sessions are limited per visitor to keep the demo responsive for everyone.",
  });
}

export function playgroundRestrictedHtml(): string {
  return cardPage({
    title: "Not available in the playground",
    heading: "Not available in the playground",
    msg: "Connecting accounts and dropping secrets are disabled for anonymous playground sessions — clearing your cookie would orphan real credentials.",
    icon: LOCK_ICON,
    actions: `<a class="btn primary" href="/">Back to the playground</a>`,
    help: "Sign in with a real account at /auth/login to use this link.",
  });
}
