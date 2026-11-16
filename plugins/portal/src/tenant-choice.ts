import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { escapeHtml, json, readBody } from "../../chassis/src/http.ts";
import { isAppHandleShape } from "../../chassis/src/dns-label.ts";
import { isTenantId } from "../../chassis/src/tenant.ts";
import { clearCookie, open, readCookie, seal, setCookie } from "./session.ts";

export interface SignInTenant {
  id: string;
  brandName?: string;
  handle?: string;
}

export interface VerifiedSignIn {
  sub: string;
  name: string;
  claims: Record<string, unknown>;
  userinfo: Record<string, unknown>;
}

export interface TrustedSignIn {
  sub: string;
  name: string;
}

export interface EmailTenants {
  tenants: SignInTenant[];
  shared: boolean;
}

export interface Workspace {
  tenant: string;
  trustedClient?: { clientId: string; clientSecret: string };
}

interface ChoiceClaims {
  k: "choice";
  signIn?: VerifiedSignIn;
  trusted?: TrustedSignIn;
  returnTo: string;
  email?: string | null;
  exp: number;
}

export function verifiedEmail(userinfo: Record<string, unknown>): string | null {
  const email = userinfo.email;
  const verified = userinfo.email_verified;
  if (typeof email !== "string" || !email.includes("@") || (verified !== true && verified !== "true")) return null;
  return email.trim().toLowerCase();
}

export function coreEmailTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
): Promise<EmailTenants> {
  return coreTenants(coreApiUrl, signingSecret, `email-tenants?email=${encodeURIComponent(email)}`);
}

function corePrincipalTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  principal: string,
): Promise<EmailTenants> {
  return coreTenants(coreApiUrl, signingSecret, `principal-tenants?principal=${encodeURIComponent(principal)}`);
}

async function coreSignInTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  who: { email?: string | null; principal: string },
): Promise<EmailTenants> {
  const [byEmail, byPrincipal] = await Promise.all([
    who.email ? coreEmailTenants(coreApiUrl, signingSecret, who.email) : undefined,
    corePrincipalTenants(coreApiUrl, signingSecret, who.principal),
  ]);
  const tenants = new Map<string, SignInTenant>();
  for (const tenant of [...(byEmail?.tenants ?? []), ...byPrincipal.tenants])
    if (!tenants.has(tenant.id)) tenants.set(tenant.id, tenant);
  return { tenants: [...tenants.values()], shared: byPrincipal.shared || byEmail?.shared === true };
}

async function coreTenants(
  coreApiUrl: string,
  signingSecret: string | undefined,
  query: string,
): Promise<EmailTenants> {
  const path = withSourceAuthNonce(`/v1/auth/broker/${query}`, signingSecret);
  const r = await fetch(`${coreApiUrl}${path}`, {
    headers: signedHeaders(signingSecret, "GET", path),
    signal: AbortSignal.timeout(4_000),
  });
  if (!r.ok) throw new Error(`workspace lookup failed: HTTP ${r.status}`);
  const body = (await r.json()) as { tenants?: unknown; shared?: unknown };
  const tenants = Array.isArray(body.tenants) ? body.tenants : [];
  const valid = tenants.flatMap((t: { id?: unknown; brandName?: unknown; handle?: unknown }) =>
    isTenantId(t?.id)
      ? [
          {
            id: t.id,
            ...(typeof t.brandName === "string" ? { brandName: t.brandName } : {}),
            ...(typeof t.handle === "string" ? { handle: t.handle } : {}),
          },
        ]
      : [],
  );
  return { tenants: valid, shared: body.shared === true };
}

export function coreWorkspace(coreApiUrl: string, signingSecret: string | undefined) {
  const cache = new LRUCache<string, { found: Workspace | null }>({ max: 1_000, ttl: 60_000 });
  return async (handle: string): Promise<Workspace | null> => {
    if (!isAppHandleShape(handle)) return null;
    const hit = cache.get(handle);
    if (hit) return hit.found;
    const path = withSourceAuthNonce(`/v1/auth/broker/workspace?handle=${encodeURIComponent(handle)}`, signingSecret);
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) throw new Error(`workspace lookup failed: HTTP ${r.status}`);
    const { tenant, trustedClient: c } = (await r.json()) as {
      tenant?: unknown;
      trustedClient?: { clientId?: unknown; clientSecret?: unknown };
    };
    const trustedClient =
      typeof c?.clientId === "string" && typeof c.clientSecret === "string" && c.clientSecret.length >= 32
        ? { clientId: c.clientId, clientSecret: c.clientSecret }
        : undefined;
    const found = isTenantId(tenant) ? { tenant, ...(trustedClient ? { trustedClient } : {}) } : null;
    cache.set(handle, { found });
    return found;
  };
}

function openChoice(token: string | null, key: Buffer, now: number): ChoiceClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "choice" || typeof p.exp !== "number" || now >= p.exp * 1000) return null;
  if (typeof p.returnTo !== "string") return null;
  return p as unknown as ChoiceClaims;
}

const PICKER_BUTTONS_MAX = 6;
const PICKER_RESULTS_MAX = 8;
const RECENT_MAX = 8;
const RECENT_COOKIE = "portal_recent_workspaces";

const PICKER_SCRIPT = `(() => {
  const input = document.getElementById("workspace-search");
  if (!input) return;
  const items = [...document.querySelectorAll("[data-workspace]")];
  const note = document.getElementById("workspace-note");
  const cap = Number(input.dataset.cap);
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0, matched = 0;
    for (const item of items) {
      const hit = !q || item.dataset.workspace.includes(q);
      if (hit) matched++;
      item.hidden = !(hit && shown < cap);
      if (!item.hidden) shown++;
    }
    note.textContent = matched === 0 ? "No workspace matches that search."
      : matched > shown ? "Showing " + shown + " of " + matched + ". Type to narrow the list." : "";
  };
  input.addEventListener("input", filter);
  input.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const first = items.find((item) => !item.hidden);
    if (first) first.requestSubmit();
  });
})();`;
const PICKER_SCRIPT_HASH = `sha256-${createHash("sha256").update(PICKER_SCRIPT).digest("base64")}`;

const workspaceLabel = ({ id, brandName, handle }: SignInTenant): string =>
  brandName?.trim() || handle || id.slice(0, 8);

function readRecent(cookieHeader: string | undefined): string[] {
  return (readCookie(cookieHeader, RECENT_COOKIE) ?? "").split(".").filter(isTenantId).slice(0, RECENT_MAX);
}

function orderWorkspaces(tenants: readonly SignInTenant[], recent: readonly string[]): SignInTenant[] {
  const rank = (id: string): number => {
    const i = recent.indexOf(id);
    return i < 0 ? recent.length : i;
  };
  return [...tenants].sort(
    (a, b) =>
      rank(a.id) - rank(b.id) || workspaceLabel(a).localeCompare(workspaceLabel(b), "en", { sensitivity: "base" }),
  );
}

function workspacePicker(
  tenants: readonly SignInTenant[],
  o: { recent?: readonly string[]; query?: string } = {},
): { actions: string; script: boolean } {
  const ordered = orderWorkspaces(tenants, o.recent ?? []);
  const button = (t: SignInTenant, hidden = false): string =>
    `<form method="post" action="/auth/tenant"${hidden ? " hidden" : ""} data-workspace="${escapeHtml(
      `${workspaceLabel(t)} ${t.handle ?? ""}`.trim().toLowerCase(),
    )}"><input type="hidden" name="tenant" value="${escapeHtml(t.id)}">` +
    `<button class="btn ghost workspace" type="submit">${escapeHtml(workspaceLabel(t))}</button></form>`;
  if (ordered.length <= PICKER_BUTTONS_MAX) return { actions: ordered.map((t) => button(t)).join(""), script: false };
  const query = (o.query ?? "").trim().toLowerCase();
  const matches = (t: SignInTenant): boolean =>
    !query || `${workspaceLabel(t)} ${t.handle ?? ""}`.toLowerCase().includes(query);
  let shown = 0;
  let matched = 0;
  const items = ordered.map((t) => {
    const hit = matches(t);
    if (hit) matched++;
    const show = hit && shown < PICKER_RESULTS_MAX;
    if (show) shown++;
    return button(t, !show);
  });
  let note = "";
  if (matched === 0) note = "No workspace matches that search.";
  else if (matched > shown) note = `Showing ${shown} of ${matched}. Type to narrow the list.`;
  const search =
    `<form method="get" action="/auth/tenant" role="search">` +
    `<input id="workspace-search" class="search" name="q" type="search" value="${escapeHtml(o.query ?? "")}" ` +
    `placeholder="Search workspaces" aria-label="Search workspaces" autocomplete="off" autofocus data-cap="${PICKER_RESULTS_MAX}">` +
    `</form>`;
  return {
    actions: `${search}${items.join("")}<p id="workspace-note" class="picker-note" aria-live="polite">${escapeHtml(note)}</p>`,
    script: true,
  };
}

type Who = Pick<ChoiceClaims, "signIn" | "trusted">;

interface CardPage {
  title: string;
  heading: string;
  msg: string;
  icon: string;
  actions: string;
  help: string;
}

export interface TenantChoiceDeps {
  core: string;
  signingSecret: string | undefined;
  key: Buffer;
  ttlS: number;
  secureCookies: boolean;
  lockIcon: string;
  sameOrigin: (req: IncomingMessage) => boolean;
  pin: (returnTo: string) => Promise<string | undefined>;
  cardPage: (o: CardPage) => string;
  signInErrorHtml: (detail: string) => string;
  noWorkspaceHtml: (email: string | null) => string;
  sendHtml: (res: ServerResponse, status: number, html: string, scriptHash?: string) => void;
  finishSignIn: (res: ServerResponse, signIn: VerifiedSignIn, returnTo: string, tenant?: string) => Promise<void>;
  finishTrustedSignIn: (
    res: ServerResponse,
    who: TrustedSignIn,
    returnTo: string,
    tenant?: string,
  ) => void | Promise<void>;
}

export function createTenantChoice(deps: TenantChoiceDeps) {
  const noAccessHtml = (): string =>
    deps.cardPage({
      title: "No access",
      heading: "No access to this workspace",
      msg: "You signed in, but this account isn't a member of this workspace.",
      icon: deps.lockIcon,
      actions: `<a class="btn primary" href="/auth/login">Sign in with a different account</a>`,
      help: "Ask an admin of this workspace to add you.",
    });

  const finish = (res: ServerResponse, who: Who, returnTo: string, tenant?: string): void | Promise<void> =>
    who.trusted
      ? deps.finishTrustedSignIn(res, who.trusted, returnTo, tenant)
      : deps.finishSignIn(res, who.signIn!, returnTo, tenant);

  function pickerPage(
    res: ServerResponse,
    tenants: readonly SignInTenant[],
    o: { recent: readonly string[]; query?: string },
  ): void {
    const picker = workspacePicker(tenants, o);
    deps.sendHtml(
      res,
      200,
      deps.cardPage({
        title: "Choose a workspace",
        heading: "Choose a workspace",
        icon: deps.lockIcon,
        msg: "Your account belongs to more than one workspace. Pick the one to sign in to.",
        actions: picker.script ? `${picker.actions}<script>${PICKER_SCRIPT}</script>` : picker.actions,
        help: "To switch later, sign out and sign in again.",
      }),
      picker.script ? PICKER_SCRIPT_HASH : undefined,
    );
  }

  function offerChoice(
    req: IncomingMessage | undefined,
    res: ServerResponse,
    who: Who,
    returnTo: string,
    tenants: SignInTenant[],
    email: string | null | undefined,
  ): void {
    const exp = Math.floor(Date.now() / 1000) + deps.ttlS;
    const choice = { k: "choice", ...who, returnTo, ...(email !== undefined ? { email } : {}), exp };
    res.setHeader("set-cookie", [
      clearCookie("portal_oidc_tmp", "/auth", deps.secureCookies),
      setCookie("portal_tenant_choice", seal(choice, deps.key), {
        path: "/auth",
        maxAge: deps.ttlS,
        secure: deps.secureCookies,
      }),
    ]);
    pickerPage(res, tenants, { recent: readRecent(req?.headers.cookie) });
  }

  function settle(
    res: ServerResponse,
    who: Who,
    returnTo: string,
    tenants: SignInTenant[],
    pin: string | undefined,
    req?: IncomingMessage,
    email?: string | null,
  ): void | Promise<void> {
    if (pin !== undefined && !tenants.some(({ id }) => id === pin)) return deps.sendHtml(res, 403, noAccessHtml());
    if (pin === undefined && tenants.length > 1) return offerChoice(req, res, who, returnTo, tenants, email);
    return finish(res, who, returnTo, pin ?? tenants[0]?.id);
  }

  function lookupTenants(choice: ChoiceClaims): Promise<EmailTenants> {
    if (choice.trusted)
      return coreSignInTenants(deps.core, deps.signingSecret, {
        email: choice.email ?? null,
        principal: choice.trusted.sub,
      });
    const email = choice.signIn ? verifiedEmail(choice.signIn.userinfo) : null;
    return email
      ? coreEmailTenants(deps.core, deps.signingSecret, email)
      : Promise.resolve({ tenants: [], shared: false });
  }

  async function settleTrusted(
    req: IncomingMessage | undefined,
    res: ServerResponse,
    identity: TrustedSignIn & {
      email: string | null;
      returnTo: string;
      tenant?: string | undefined;
    },
  ): Promise<void> {
    const found = await coreSignInTenants(deps.core, deps.signingSecret, {
      email: identity.email,
      principal: identity.sub,
    });
    const who = { sub: identity.sub, name: identity.name };
    const pin = identity.tenant ?? (await deps.pin(identity.returnTo));
    if (found.shared && !found.tenants.length)
      return deps.sendHtml(res, 403, pin === undefined ? deps.noWorkspaceHtml(identity.email) : noAccessHtml());
    await settle(res, { trusted: who }, identity.returnTo, found.tenants, pin, req, identity.email);
  }

  const expired = (res: ServerResponse): void => {
    res.setHeader("set-cookie", [clearCookie("portal_tenant_choice", "/auth", deps.secureCookies)]);
    deps.sendHtml(res, 400, deps.signInErrorHtml("workspace choice expired, please sign in again"));
  };

  async function choose(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.sameOrigin(req)) return json(res, 403, { error: "forbidden" });
    const choice = openChoice(readCookie(req.headers.cookie, "portal_tenant_choice"), deps.key, Date.now());
    const tenant = new URLSearchParams(await readBody(req, 4096)).get("tenant") ?? "";
    if (!choice || !isTenantId(tenant) || (!choice.signIn && !choice.trusted)) return expired(res);
    const { tenants } = await lookupTenants(choice);
    if (!tenants.some(({ id }) => id === tenant)) return expired(res);
    const recent = [tenant, ...readRecent(req.headers.cookie).filter((id) => id !== tenant)].slice(0, RECENT_MAX);
    res.setHeader("set-cookie", [
      setCookie(RECENT_COOKIE, recent.join("."), {
        path: "/auth",
        maxAge: 400 * 86400,
        secure: deps.secureCookies,
      }),
    ]);
    return finish(res, choice, choice.returnTo, tenant);
  }

  async function search(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const choice = openChoice(readCookie(req.headers.cookie, "portal_tenant_choice"), deps.key, Date.now());
    if (!choice || (!choice.signIn && !choice.trusted)) return expired(res);
    const { tenants } = await lookupTenants(choice);
    pickerPage(res, tenants, { recent: readRecent(req.headers.cookie), query: url.searchParams.get("q") ?? "" });
  }

  return { settle, settleTrusted, choose, search };
}
