import type { UNATTENDED_ADMIN_GRANTS } from "../control-service.ts";
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
  capability?: CapabilityClaims | null;
}

export interface ApiCtx extends BaseCtx {
  body: unknown;
  capability: CapabilityClaims | null;
  actor?: PortalIdentity | null;
}

export type RouteAuth = "either" | "source" | "public" | { aud: string };

export type RouteActor = "person" | "system" | `${"query" | "body"}.${string}`;

export interface AdminAccess {
  agent?: "anyone" | { portalOnly: string };
  privateRead?: "always" | "unless-org-scope";
  unattended?: { grant: (typeof UNATTENDED_ADMIN_GRANTS)[number]; summary: string };
}

export type Route<C extends BaseCtx = ApiCtx> = {
  handle: (ctx: C) => void | Promise<void>;
  auth: RouteAuth;
  actor?: RouteActor;
  admin?: AdminAccess;
  allowedInStrict?: true;
  maxBodyBytes?: number;
} & ({ method: string; path: string } | { match: (method: string, pathname: string) => boolean });

export function withActor<C extends BaseCtx>(actor: RouteActor, routes: Route<C>[]): Route<C>[] {
  return routes.map((route) => ({ actor, ...route }));
}

export function withAdmin<C extends BaseCtx>(routes: Route<C>[]): Route<C>[] {
  return routes.map((route) => ({ actor: "person", admin: {}, ...route }));
}

export async function run<C extends BaseCtx>(route: Route<C>, params: Record<string, string>, ctx: C): Promise<void> {
  ctx.params = params;
  await route.handle(ctx);
}
