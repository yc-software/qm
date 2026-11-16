import type { UpgradeTarget } from "../../../plugins/chassis/src/websocket-relay.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readCookie } from "../../../plugins/portal/src/session.ts";
import { CAPABILITY_HEADER } from "../contract.ts";
import { compilePath, findRoute } from "../../../plugins/chassis/src/router.ts";

export { compilePath, findRoute };
import type { App } from "../app.ts";
import type { ServerDeps } from "../deps.ts";
import type { SourceAuth } from "../../auth/source-auth.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import type { PortalIdentity } from "../../auth/portal-identity.ts";
import { withModelRequestContext } from "../../model/request-context.ts";
import type { TenantKey } from "../../tenants/lookup.ts";
import type { Tenant } from "../../tenants/context.ts";

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
  tenant?: Tenant;
  capability?: CapabilityClaims | null;
  upgrade?: UpgradeTarget;
}

export interface ApiCtx extends BaseCtx {
  body: unknown;
  capability: CapabilityClaims | null;
  actor?: PortalIdentity | null;
}

export interface KeyedTenant {
  by: TenantKey;
  key: (params: Record<string, string>, url: URL) => string | undefined;
  signedTenantFirst?: true;
}

export type RouteAuth = "either" | "source" | "public" | { aud: string; bearer?: true };

export type RouteActor = "person" | "system" | `${"query" | "body"}.${string}`;

export interface AdminAccess {
  agent?: "anyone" | { portalOnly: string };
  privateRead?: "always" | "unless-org-scope";
}

export type Route<C extends BaseCtx = ApiCtx> = {
  handle: (ctx: C) => void | Promise<void>;
  auth: RouteAuth;
  actor?: RouteActor;
  admin?: AdminAccess;
  allowedInStrict?: true;
  tenant?: "none" | "optional" | KeyedTenant;
  browser?: true | "embed" | "self";
  maxBodyBytes?: number;
  streamBody?: true;
} & ({ method: string; path: string } | { match: (method: string, pathname: string) => boolean });

export function tenantOf(ctx: Pick<BaseCtx, "tenant">): Tenant {
  if (!ctx.tenant) throw new Error("No tenant is bound to this request");
  return ctx.tenant;
}

export function withActor<C extends BaseCtx>(actor: RouteActor, routes: Route<C>[]): Route<C>[] {
  return routes.map((route) => ({ actor, ...route }));
}

export function withAdmin<C extends BaseCtx>(routes: Route<C>[]): Route<C>[] {
  return routes.map((route) => ({ actor: "person", admin: {}, ...route }));
}

export async function run<C extends BaseCtx>(route: Route<C>, params: Record<string, string>, ctx: C): Promise<void> {
  ctx.params = params;
  await withModelRequestContext(ctx.capability ?? {}, () => route.handle(ctx));
}

export function usesBrowserSession(req: IncomingMessage, route: Pick<Route, "browser"> | undefined): boolean {
  return (
    route?.browser !== undefined &&
    req.headers[CAPABILITY_HEADER] === undefined &&
    req.headers["x-signature"] === undefined &&
    readCookie(req.headers.cookie, "portal_session") !== null
  );
}
