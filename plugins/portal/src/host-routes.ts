import type { IncomingMessage, ServerResponse } from "node:http";
import { hostName, hostReturnTo, mintHandoff, openHandoff, type HostRecord, type MappedHost } from "./host-tenant.ts";

interface HostSession {
  sub: string;
  name?: string;
  t?: string;
  anon?: boolean;
  appOnly?: boolean;
}

export interface HostRouteDeps {
  publicUrl: string;
  appsDomain?: string;
  lookup(host: string): Promise<HostRecord | null>;
  handoffKey: Buffer;
  claim(jti: string): Promise<boolean>;
  session(req: IncomingMessage): HostSession | null;
  signOut(res: ServerResponse): void;
  signIn(res: ServerResponse, who: { sub: string; name?: string; t: string }): void;
  page(res: ServerResponse, status: number, html: string): void;
  errorHtml(detail: string): string;
  unavailable(res: ServerResponse): void;
}

const MAPPED_AUTH_PATHS = ["/auth/logout", "/auth/signed-out", "/auth/impersonate", "/auth/impersonate/stop"];

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
}

export function createHostRoutes(deps: HostRouteDeps) {
  const shared = new URL(deps.publicUrl);
  const appsDomain = deps.appsDomain?.toLowerCase();

  async function target(to: string | null): Promise<MappedHost | null> {
    let url: URL;
    try {
      url = new URL(to ?? "");
    } catch {
      return null;
    }
    if (url.protocol !== shared.protocol || url.username || url.password) return null;
    const record = await deps.lookup(hostName(url.host));
    return record ? { ...record, host: hostName(url.host), origin: url.origin } : null;
  }

  return {
    async resolve(req: IncomingMessage, res: ServerResponse): Promise<MappedHost | undefined | null> {
      const host = hostName(req.headers.host);
      if (!host || host === hostName(shared.host) || (req.url ?? "").split("?")[0] === "/healthz") return;
      if (host === "localhost" || host.startsWith("[") || /^[\d.]+$/.test(host)) return;
      if (appsDomain && (host === appsDomain || host.endsWith(`.${appsDomain}`))) return;
      try {
        const record = await deps.lookup(host);
        return record ? { ...record, host, origin: `${shared.protocol}//${req.headers.host}` } : undefined;
      } catch (error) {
        console.warn(`[portal] could not resolve the workspace for a host: ${String(error)}`);
        deps.unavailable(res);
        return null;
      }
    },

    async pin(returnTo: string): Promise<string | undefined> {
      const url = new URL(returnTo, shared);
      if (url.origin !== shared.origin || url.pathname !== "/auth/host") return undefined;
      return (await target(url.searchParams.get("to")))?.tenant ?? "";
    },

    async mapped(req: IncomingMessage, res: ServerResponse, url: URL, mapped: MappedHost): Promise<boolean> {
      const method = req.method ?? "GET";
      const returnTo = hostReturnTo(url.searchParams.get("returnTo"));
      if (mapped.trustedClient && url.pathname.startsWith("/auth/trusted/")) return false;
      if (method === "GET" && mapped.trustedClient && url.pathname === "/auth/login") {
        redirect(res, `/auth/trusted/login?returnTo=${encodeURIComponent(returnTo)}`);
        return true;
      }
      if (method === "GET" && (url.pathname === "/auth/login" || url.pathname === "/auth/trusted/login")) {
        redirect(res, `${shared.origin}/auth/host?to=${encodeURIComponent(`${mapped.origin}${returnTo}`)}`);
        return true;
      }
      if (method === "GET" && url.pathname === "/auth/handoff") {
        const claims = openHandoff(url.searchParams.get("token"), deps.handoffKey, mapped);
        if (!claims || !(await deps.claim(claims.jti))) {
          deps.page(res, 400, deps.errorHtml("sign-in link expired or already used"));
          return true;
        }
        deps.signIn(res, claims);
        redirect(res, hostReturnTo(claims.returnTo));
        return true;
      }
      if (MAPPED_AUTH_PATHS.includes(url.pathname)) return false;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return true;
    },

    async handoff(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const to = url.searchParams.get("to");
      const host = await target(to);
      if (!host) return deps.page(res, 400, deps.errorHtml("unknown workspace address"));
      const session = deps.session(req);
      if (!session || session.anon || session.appOnly || session.t !== host.tenant) {
        deps.signOut(res);
        return redirect(res, `/auth/login?returnTo=${encodeURIComponent(`/auth/host?to=${encodeURIComponent(to!)}`)}`);
      }
      const back = new URL(to!);
      const token = mintHandoff(session, host, `${back.pathname}${back.search}`, deps.handoffKey);
      redirect(res, `${host.origin}/auth/handoff?token=${token}`);
    },
  };
}
