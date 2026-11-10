import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { LRUCache } from "lru-cache";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { isTenantId } from "../../chassis/src/tenant.ts";
import { open, seal } from "./session.ts";

interface AppTarget {
  tenant: string;
  host: string;
  origin: string;
}

interface HandoffClaims {
  k: "handoff";
  sub: string;
  name?: string;
  t: string;
  host: string;
  returnTo: string;
  jti: string;
  exp: number;
}

interface HandoffSession {
  sub: string;
  name?: string;
  t?: string;
  appOnly?: boolean;
}

export interface AppHandoffDeps {
  publicUrl: string;
  lookup(host: string): Promise<string | null>;
  handoffKey: Buffer;
  claim(jti: string): Promise<boolean>;
  session(req: IncomingMessage): HandoffSession | null;
  signOut(res: ServerResponse): void;
  signInApp(res: ServerResponse, who: { sub: string; name?: string; t: string }): void;
  page(res: ServerResponse, status: number, html: string): void;
  errorHtml(detail: string): string;
}

const HANDOFF_TTL_S = 60;

function hostName(value: string | undefined): string {
  return (value ?? "").toLowerCase().split(":")[0]!;
}

function hostReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x1f]/.test(value) ? value : "/";
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

export function coreAppHostTenant(coreApiUrl: string, signingSecret: string | undefined) {
  const cache = new LRUCache<string, { tenant: string | null }>({ max: 1_000, ttl: 60_000 });
  return async (host: string): Promise<string | null> => {
    const hit = cache.get(host);
    if (hit) return hit.tenant;
    const path = withSourceAuthNonce(`/v1/auth/broker/host-tenant?host=${encodeURIComponent(host)}`, signingSecret);
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) throw new Error(`host lookup failed: HTTP ${r.status}`);
    const { tenant, app } = (await r.json()) as { tenant?: unknown; app?: unknown };
    const found = app === true && isTenantId(tenant) ? tenant : null;
    cache.set(host, { tenant: found });
    return found;
  };
}

function mintHandoff(who: HandoffSession, target: AppTarget, returnTo: string, key: Buffer): string {
  const claims: HandoffClaims = {
    k: "handoff",
    sub: who.sub,
    ...(who.name ? { name: who.name } : {}),
    t: target.tenant,
    host: target.host,
    returnTo: hostReturnTo(returnTo),
    jti: randomBytes(16).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + HANDOFF_TTL_S,
  };
  return seal(claims, key);
}

function openHandoff(token: string | null, key: Buffer, tenant: string, host: string): HandoffClaims | null {
  const p = open(token, key);
  if (!p || p.k !== "handoff" || typeof p.exp !== "number" || Date.now() >= p.exp * 1000) return null;
  if (typeof p.sub !== "string" || !p.sub || typeof p.jti !== "string" || typeof p.returnTo !== "string") return null;
  if (p.t !== tenant || p.host !== host) return null;
  return p as unknown as HandoffClaims;
}

export function createAppHandoff(deps: AppHandoffDeps) {
  const shared = new URL(deps.publicUrl);

  async function target(to: string | null): Promise<AppTarget | null> {
    let url: URL;
    try {
      url = new URL(to ?? "");
    } catch {
      return null;
    }
    if (url.protocol !== shared.protocol || url.username || url.password) return null;
    const tenant = await deps.lookup(hostName(url.host));
    return tenant ? { tenant, host: hostName(url.host), origin: url.origin } : null;
  }

  return {
    async pin(returnTo: string): Promise<string | undefined> {
      const url = new URL(returnTo, shared);
      if (url.origin !== shared.origin || url.pathname !== "/auth/host") return undefined;
      return (await target(url.searchParams.get("to")))?.tenant ?? "";
    },

    async redeem(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (req.method !== "GET" || url.pathname !== "/auth/handoff") return false;
      const host = hostName(req.headers.host);
      const tenant = await deps.lookup(host);
      const claims = tenant ? openHandoff(url.searchParams.get("token"), deps.handoffKey, tenant, host) : null;
      if (!claims || !(await deps.claim(claims.jti))) {
        deps.page(res, 400, deps.errorHtml("sign-in link expired or already used"));
        return true;
      }
      deps.signInApp(res, claims);
      redirect(res, hostReturnTo(claims.returnTo));
      return true;
    },

    async start(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const to = url.searchParams.get("to") ?? "";
      const app = await target(to);
      if (!app) return deps.page(res, 400, deps.errorHtml("unknown app address"));
      const session = deps.session(req);
      if (!session || session.appOnly || session.t !== app.tenant) {
        deps.signOut(res);
        return redirect(res, `/auth/login?returnTo=${encodeURIComponent(`/auth/host?to=${encodeURIComponent(to)}`)}`);
      }
      const back = new URL(to);
      redirect(
        res,
        `${app.origin}/auth/handoff?token=${mintHandoff(session, app, `${back.pathname}${back.search}`, deps.handoffKey)}`,
      );
    },
  };
}
