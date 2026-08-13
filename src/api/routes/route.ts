import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app.ts";
import type { ServerDeps } from "../deps.ts";
import type { SourceAuth } from "../../auth/source-auth.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import type { PortalIdentity } from "../../auth/portal-identity.ts";

export interface BaseCtx {
  req: IncomingMessage;
  res: ServerResponse;
  app: App;
  deps: ServerDeps;
  secret: string | undefined;
  auth: SourceAuth | null;
  allowUnsignedSourceAuth: boolean;
  url: URL;
  pathname: string;
  method: string;
  params: Record<string, string>;
}

export interface ApiCtx extends BaseCtx {
  body: unknown;
  capability: CapabilityClaims | null;
  actor?: PortalIdentity | null;
}

export type RouteAuth = "either" | "source" | "public" | { aud: string; source?: boolean };

export type Route<C extends BaseCtx = ApiCtx> = {
  handle: (ctx: C) => void | Promise<void>;
  auth: RouteAuth;
} & ({ method: string; path: string } | { match: (method: string, pathname: string) => boolean });

interface Matcher {
  test: (method: string, pathname: string, params: Record<string, string>) => boolean;
}

export function compilePath(path: string): Matcher {
  const want = path.split("/").map((seg) => (seg.startsWith(":") ? { param: seg.slice(1) } : { literal: seg }));
  return {
    test(_method, pathname, out) {
      const got = pathname.split("/");
      if (got.length !== want.length) return false;
      for (let i = 0; i < want.length; i++) {
        const seg = want[i]!;
        const value = got[i]!;
        if ("literal" in seg) {
          if (value !== seg.literal) return false;
        } else {
          try {
            out[seg.param] = decodeURIComponent(value);
          } catch {
            return false;
          }
        }
      }
      return true;
    },
  };
}

function matcherFor<C extends BaseCtx>(
  route: Route<C>,
): (method: string, pathname: string, params: Record<string, string>) => boolean {
  if ("path" in route) {
    const compiled = compilePath(route.path);
    return (method, pathname, params) => method === route.method && compiled.test(method, pathname, params);
  }
  return (method, pathname) => route.match(method, pathname);
}

export function findRoute<C extends BaseCtx>(
  routes: ReadonlyArray<Route<C>>,
  method: string,
  pathname: string,
): { route: Route<C>; params: Record<string, string> } | null {
  for (const route of routes) {
    const params: Record<string, string> = {};
    if (matcherFor(route)(method, pathname, params)) return { route, params };
  }
  return null;
}

export async function run<C extends BaseCtx>(route: Route<C>, params: Record<string, string>, ctx: C): Promise<void> {
  ctx.params = params;
  await route.handle(ctx);
}

export async function dispatch<C extends BaseCtx>(routes: ReadonlyArray<Route<C>>, ctx: C): Promise<boolean> {
  const found = findRoute(routes, ctx.method, ctx.pathname);
  if (!found) return false;
  await run(found.route, found.params, ctx);
  return true;
}
