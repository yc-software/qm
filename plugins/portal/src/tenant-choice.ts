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
  tenants: string[];
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
  const valid = tenants.flatMap((t: { id?: unknown; brandName?: unknown }) =>
    isTenantId(t?.id) ? [{ id: t.id, ...(typeof t.brandName === "string" ? { brandName: t.brandName } : {}) }] : [],
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
  if (!Array.isArray(p.tenants) || !p.tenants.every(isTenantId) || typeof p.returnTo !== "string") return null;
  return p as unknown as ChoiceClaims;
}

function tenantChoiceForms(tenants: readonly SignInTenant[], escape: (s: string) => string): string {
  return tenants
    .map(
      ({ id, brandName }) =>
        `<form method="post" action="/auth/tenant"><input type="hidden" name="tenant" value="${escape(id)}">` +
        `<button class="btn primary" type="submit">${escape(brandName?.trim() || id.slice(0, 8))}</button></form>`,
    )
    .join("");
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
  sendHtml: (res: ServerResponse, status: number, html: string) => void;
  finishSignIn: (res: ServerResponse, signIn: VerifiedSignIn, returnTo: string, tenant?: string) => Promise<void>;
  finishTrustedSignIn: (res: ServerResponse, who: TrustedSignIn, returnTo: string, tenant?: string) => void;
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

  function offerChoice(res: ServerResponse, who: Who, returnTo: string, tenants: SignInTenant[]): void {
    const exp = Math.floor(Date.now() / 1000) + deps.ttlS;
    const choice = { k: "choice", ...who, returnTo, tenants: tenants.map(({ id }) => id), exp };
    res.setHeader("set-cookie", [
      clearCookie("portal_oidc_tmp", "/auth", deps.secureCookies),
      setCookie("portal_tenant_choice", seal(choice, deps.key), {
        path: "/auth",
        maxAge: deps.ttlS,
        secure: deps.secureCookies,
      }),
    ]);
    deps.sendHtml(
      res,
      200,
      deps.cardPage({
        title: "Choose a workspace",
        heading: "Choose a workspace",
        icon: deps.lockIcon,
        msg: "Your account belongs to more than one workspace. Pick the one to sign in to.",
        actions: tenantChoiceForms(tenants, escapeHtml),
        help: "To switch later, sign out and sign in again.",
      }),
    );
  }

  function settle(
    res: ServerResponse,
    who: Who,
    returnTo: string,
    tenants: SignInTenant[],
    pin: string | undefined,
  ): void | Promise<void> {
    if (pin !== undefined && !tenants.some(({ id }) => id === pin)) return deps.sendHtml(res, 403, noAccessHtml());
    if (pin === undefined && tenants.length > 1) return offerChoice(res, who, returnTo, tenants);
    return finish(res, who, returnTo, pin ?? tenants[0]?.id);
  }

  async function settleTrusted(
    res: ServerResponse,
    identity: TrustedSignIn & { email: string | null; returnTo: string; tenant?: string | undefined },
  ): Promise<void> {
    const found = await coreSignInTenants(deps.core, deps.signingSecret, {
      email: identity.email,
      principal: identity.sub,
    });
    if (found.shared && !found.tenants.length) return deps.sendHtml(res, 403, noAccessHtml());
    const who = { sub: identity.sub, name: identity.name };
    const pin = identity.tenant ?? (await deps.pin(identity.returnTo));
    await settle(res, { trusted: who }, identity.returnTo, found.tenants, pin);
  }

  async function choose(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.sameOrigin(req)) return json(res, 403, { error: "forbidden" });
    const choice = openChoice(readCookie(req.headers.cookie, "portal_tenant_choice"), deps.key, Date.now());
    const tenant = new URLSearchParams(await readBody(req, 4096)).get("tenant") ?? "";
    if (!choice || !choice.tenants.includes(tenant) || (!choice.signIn && !choice.trusted)) {
      res.setHeader("set-cookie", [clearCookie("portal_tenant_choice", "/auth", deps.secureCookies)]);
      return deps.sendHtml(res, 400, deps.signInErrorHtml("workspace choice expired, please sign in again"));
    }
    return finish(res, choice, choice.returnTo, tenant);
  }

  return { settle, settleTrusted, choose };
}
