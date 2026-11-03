import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCapabilityToken, type VerifiedCapability } from "../auth/capability-token.ts";
import { isTenantId, withTenant } from "../tenants/context.ts";
import { tenantSettings } from "../tenants/settings.ts";
import { requestHost, type RowTable, type Tenancy } from "../tenants/tenancy.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { sendJson, tenantHeader } from "./http.ts";
import type { Route } from "./routes/route.ts";

const verified = new WeakMap<
  IncomingMessage,
  { token: string; secret: string | undefined; claims: Promise<VerifiedCapability | null> }
>();

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
  const cached = verified.get(req);
  if (cached?.token === token && cached.secret === secret) return cached.claims;
  const claims = secret ? verifyCapabilityToken(token, secret) : Promise.resolve(null);
  verified.set(req, { token, secret, claims });
  return claims;
}

async function claimedTenant(
  req: IncomingMessage,
  auth: Route["auth"] | undefined,
  capabilitySecret: string | undefined,
): Promise<{ tenant?: string; refusal?: string }> {
  const header = tenantHeader(req);
  if (header && !isTenantId(header)) return { refusal: "malformed tenant" };
  const token = capabilityToken(req, typeof auth === "object" && auth.bearer === true);
  if (!token) return header ? { tenant: header } : {};
  const claims = await requestCapability(req, token, capabilitySecret);
  if (!claims) return {};
  if (header && claims.tenant !== header) return { refusal: "tenant header conflicts with the capability token" };
  return claims.tenant ? { tenant: claims.tenant } : {};
}

let loadTenantCaches: (() => Promise<void>) | undefined;

export function configureTenantCaches(load: (() => Promise<void>) | undefined): void {
  loadTenantCaches = load;
}

export function bindTenant(tenant: string, next: () => Promise<void> | void): Promise<void> {
  return withTenant(tenant, async () => {
    await tenantSettings();
    await loadTenantCaches?.();
    await next();
  });
}

const rowExpectations = new WeakMap<IncomingMessage, string>();

function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message });
  req.resume();
}

export async function withRequestTenant(
  req: IncomingMessage,
  res: ServerResponse,
  route: Pick<Route, "auth" | "tenant"> | undefined,
  capabilitySecret: string | undefined,
  tenancy: Pick<Tenancy, "hostTenant"> | undefined,
  next: () => Promise<void> | void,
): Promise<void> {
  if (route?.tenant === "none") return next();
  const host = tenancy ? await tenancy.hostTenant(requestHost(req.headers.host)) : { multi: false };
  const { tenant: claimed, refusal } =
    route?.auth === "public" ? {} : await claimedTenant(req, route?.auth, capabilitySecret);
  if (refusal) return refuse(req, res, 400, "bad_request", refusal);
  if (host.tenant && claimed && host.tenant !== claimed)
    return refuse(req, res, 403, "tenant_mismatch", "this credential belongs to a different tenant than this host");
  const tenant = host.tenant ?? claimed;
  if (route?.tenant === "row") {
    if (tenant) rowExpectations.set(req, tenant);
    return next();
  }
  if (tenant) return bindTenant(tenant, next);
  if (host.multi) return refuse(req, res, 421, "unknown_host", "this host does not belong to a known tenant");
  return next();
}

export async function withRowTenant(
  req: IncomingMessage,
  res: ServerResponse,
  tenancy: Pick<Tenancy, "rowTenant" | "multi"> | undefined,
  row: { table: RowTable; id: string },
  next: () => Promise<void> | void,
): Promise<void> {
  if (!tenancy) return next();
  const tenant = await tenancy.rowTenant(row.table, row.id);
  const expected = rowExpectations.get(req);
  if (tenant && (!expected || expected === tenant)) return bindTenant(tenant, next);
  if (!tenant && !expected && !(await tenancy.multi())) return next();
  return refuse(req, res, 404, "not_found", `${req.method} ${(req.url ?? "").split("?")[0]}`);
}
