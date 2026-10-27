import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { ALERT_ICON, cardPage as chassisCardPage, LOCK_ICON } from "../../chassis/src/card-page.ts";
import { json, escapeHtml, sendBuffered } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { brandLabel } from "./core-calls.ts";

export const cardPage = (o: Parameters<typeof chassisCardPage>[0]): string =>
  chassisCardPage({ ...o, brand: brandLabel() });
const CARD_SCENE_FILE = fileURLToPath(
  new URL("../../../desktop/assets/becalmed-off-halfway-rock.webp", import.meta.url),
);

export function identityUnavailable(req: IncomingMessage, res: ServerResponse): void {
  if (wantsHtml(req))
    return sendHtml(
      res,
      503,
      connectPage({ title: "Service unavailable", body: "Could not confirm your identity. Try again in a moment." }),
    );
  json(res, 503, { error: "identity_unavailable", message: "could not confirm your identity, try again in a moment" });
}

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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

export function sendHtml(res: ServerResponse, status: number, html: string, csp = PAGE_CSP): void {
  sendBuffered(
    res,
    status,
    {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
    html,
  );
}

export function redirect(res: ServerResponse, status: number, location: string): void {
  res.writeHead(status, { location, "cache-control": "no-store" });
  res.end();
}

export function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
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
