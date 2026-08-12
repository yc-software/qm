import type { IncomingMessage, ServerResponse } from "node:http";
import { compilePath, findRoute } from "../../../plugins/chassis/src/router.ts";

export { compilePath, findRoute };
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

export type RouteAuth = "either" | "source" | "public" | { aud: string };

export type Route<C extends BaseCtx = ApiCtx> = {
  handle: (ctx: C) => void | Promise<void>;
  auth: RouteAuth;
} & ({ method: string; path: string } | { match: (method: string, pathname: string) => boolean });

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
