import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCapabilityToken, type VerifiedCapability } from "../auth/capability-token.ts";
import { isTenantId, withTenant } from "../tenants/context.ts";
import type { TenantResolver } from "../tenants/resolver.ts";
import type { RowTenants } from "../tenants/row-tenant.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { sendJson, tenantHeader } from "./http.ts";
import type { Route } from "./routes/route.ts";

const verified = new WeakMap<IncomingMessage, Promise<VerifiedCapability | null>>();

export function capabilityToken(req: IncomingMessage, bearer: boolean): string | null {
  const header = req.headers[CAPABILITY_HEADER];
  if (typeof header === "string" && header) return header;
  if (!bearer) return null;
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  return /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
}

export function requestCapability(
  req: IncomingMessage,
  token: string,
  secret: string | undefined,
): Promise<VerifiedCapability | null> {
  let claims = verified.get(req);
  if (!claims) {
    claims = secret ? verifyCapabilityToken(token, secret) : Promise.resolve(null);
    verified.set(req, claims);
  }
  return claims;
}

function requestHost(req: IncomingMessage): string {
  return (req.headers.host ?? "").split(":")[0]!.toLowerCase();
}

async function claimedTenant(
  req: IncomingMessage,
  auth: Route["auth"] | undefined,
  capabilitySecret: string | undefined,
): Promise<string | null> {
  const token = capabilityToken(req, typeof auth === "object" && auth.bearer === true);
  if (token) return (await requestCapability(req, token, capabilitySecret))?.tenant ?? null;
  const header = tenantHeader(req);
  return isTenantId(header) ? header : null;
}

export async function withRequestTenant(
  req: IncomingMessage,
  res: ServerResponse,
  route: Pick<Route, "auth" | "unbound"> | undefined,
  deps: { tenants?: TenantResolver; capabilitySecret: string | undefined; unsignedTenant: string | null },
  next: () => Promise<void> | void,
): Promise<void> {
  if (route?.auth === "public") return next();
  const tenant = (await claimedTenant(req, route?.auth, deps.capabilitySecret)) ?? deps.unsignedTenant;
  if (!tenant && route?.unbound) return next();
  if (!tenant) {
    sendJson(res, 401, { error: "unauthorized", message: "this request carries no verifiable tenant" });
    return void req.resume();
  }
  const hostTenant = deps.tenants ? await deps.tenants.forHost(requestHost(req)) : null;
  if (hostTenant && hostTenant !== tenant) {
    sendJson(res, 403, { error: "forbidden", message: "this credential belongs to another tenant" });
    return void req.resume();
  }
  return withTenant(tenant, next);
}

export async function withRowTenant(
  res: ServerResponse,
  rowTenants: RowTenants | undefined,
  row: { table: string; columns: readonly string[]; id: string },
  next: () => Promise<void> | void,
): Promise<void> {
  const tenants = rowTenants ? await rowTenants(row.table, row.columns, row.id) : [];
  if (tenants.length !== 1) return sendJson(res, 404, { error: "not_found" });
  return withTenant(tenants[0]!, next);
}
