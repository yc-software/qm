import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { escapeHtml, json } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { HARBOUR_SCENE_PATH, HARBOUR_STYLE, harbourScene } from "../../chassis/src/harbour.ts";

let brandSource: () => string | undefined = () => undefined;
export function setCardBrandSource(source: () => string | undefined): void {
  brandSource = source;
}
const brandLabel = (): string => brandSource()?.trim() || "QM";

export { HARBOUR_SCENE_PATH as CARD_SCENE_PATH };
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
<title>${escapeHtml(o.title)} · ${escapeHtml(brandLabel())}</title>
${HARBOUR_STYLE}
</head>
<body>
  <main>
    ${harbourScene(brandLabel())}
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

export function noWorkspaceHtml(email: string | null): string {
  const brand = brandLabel();
  return cardPage({
    title: "No workspace",
    heading: `No ${brand} workspace for this account yet`,
    msg: `This account isn't in a ${brand} workspace yet.`,
    icon: LOCK_ICON,
    extra: `<p class="account"><strong>Signed in as</strong>${escapeHtml(email ?? "an account without an email address")}</p>`,
    actions: `<a class="btn ghost workspace" href="/auth/login">Sign in with a different account</a>`,
    help: "If you expected access, ask someone on your team to add this email address to your workspace.",
  });
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
