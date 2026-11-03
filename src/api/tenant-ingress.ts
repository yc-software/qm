import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCapabilityToken, type VerifiedCapability } from "../auth/capability-token.ts";
import { isTenantId, withTenant } from "../tenants/context.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { sendJson, tenantHeader } from "./http.ts";
import type { Route } from "./routes/route.ts";

const verified = new WeakMap<IncomingMessage, { token: string; claims: Promise<VerifiedCapability | null> }>();

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
  if (cached?.token === token) return cached.claims;
  const claims = secret ? verifyCapabilityToken(token, secret) : Promise.resolve(null);
  verified.set(req, { token, claims });
  return claims;
}

async function claimedTenant(
  req: IncomingMessage,
  auth: Route["auth"] | undefined,
  capabilitySecret: string | undefined,
): Promise<string | null> {
  const token = capabilityToken(req, typeof auth === "object" && auth.bearer === true);
  if (token) return (await requestCapability(req, token, capabilitySecret))?.tenant ?? null;
  return tenantHeader(req) || null;
}

export async function withRequestTenant(
  req: IncomingMessage,
  res: ServerResponse,
  route: Pick<Route, "auth"> | undefined,
  capabilitySecret: string | undefined,
  next: () => Promise<void> | void,
): Promise<void> {
  if (route?.auth === "public") return next();
  const tenant = await claimedTenant(req, route?.auth, capabilitySecret);
  if (tenant && !isTenantId(tenant)) {
    sendJson(res, 400, { error: "bad_request", message: "malformed tenant" });
    return void req.resume();
  }
  return tenant ? withTenant(tenant, next) : next();
}
