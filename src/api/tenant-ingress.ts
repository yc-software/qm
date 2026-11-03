import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCapabilityToken, type VerifiedCapability } from "../auth/capability-token.ts";
import { isTenantId, withTenant } from "../tenants/context.ts";
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

export async function withRequestTenant(
  req: IncomingMessage,
  res: ServerResponse,
  route: Pick<Route, "auth"> | undefined,
  capabilitySecret: string | undefined,
  next: () => Promise<void> | void,
  loadTenant?: () => Promise<void>,
): Promise<void> {
  if (route?.auth === "public") return next();
  const { tenant, refusal } = await claimedTenant(req, route?.auth, capabilitySecret);
  if (refusal) {
    sendJson(res, 400, { error: "bad_request", message: refusal });
    return void req.resume();
  }
  return tenant ? withLoadedTenant(tenant, next, loadTenant) : next();
}

export function withLoadedTenant(
  tenant: string,
  next: () => Promise<void> | void,
  loadTenant: (() => Promise<void>) | undefined,
): Promise<void> {
  return withTenant(tenant, async () => {
    await loadTenant?.();
    await next();
  });
}
