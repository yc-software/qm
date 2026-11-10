import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCapabilityToken, type CapabilityClaims } from "../auth/capability-token.ts";
import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../auth/portal-identity.ts";
import { inTenant } from "../tenants/claim.ts";
import type { Tenant } from "../tenants/context.ts";
import { CAPABILITY_HEADER } from "./contract.ts";
import { sendJson } from "./http.ts";
import type { Route } from "./routes/route.ts";

const verified = new WeakMap<IncomingMessage, { token: string; claims: Promise<CapabilityClaims | null> }>();

export function capabilityToken(req: IncomingMessage, bearer: boolean): string | null {
  const header = req.headers[CAPABILITY_HEADER];
  if (typeof header === "string" && header) return header;
  if (!bearer) return null;
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  return bearerToken(req);
}

export function bearerToken(req: IncomingMessage): string | null {
  const [scheme, token, ...rest] = (req.headers.authorization ?? "").split(" ");
  return scheme?.toLowerCase() === "bearer" && token && !rest.length ? token : null;
}

export function requestCapability(
  req: IncomingMessage,
  token: string,
  secret: string | undefined,
): Promise<CapabilityClaims | null> {
  const cached = verified.get(req);
  if (cached?.token === token) return cached.claims;
  const claims = secret ? verifyCapabilityToken(token, secret) : Promise.resolve(null);
  verified.set(req, { token, claims });
  return claims;
}

export async function identityTenant(req: IncomingMessage, secret: string | undefined): Promise<string | undefined> {
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  return token && secret ? (await verifyPortalIdentity(token, secret, Date.now()))?.t : undefined;
}

export async function withRequestTenant(
  req: IncomingMessage,
  res: ServerResponse,
  route: Pick<Route, "auth" | "tenant"> | undefined,
  capabilitySecret: string | undefined,
  bootTenant: string | undefined,
  next: (tenant: Tenant | undefined) => Promise<void> | void,
  identitySecret?: string,
  browserTenant?: () => string | undefined,
): Promise<void> {
  if (route?.tenant === "none") return next(undefined);
  const token = capabilityToken(req, typeof route?.auth === "object" && route.auth.bearer === true);
  const claims = token ? await requestCapability(req, token, capabilitySecret) : null;
  const tenant = claims?.tenant ?? (await identityTenant(req, identitySecret)) ?? browserTenant?.() ?? bootTenant;
  if (tenant) return inTenant(tenant, async (bound) => next(bound));
  if (route?.tenant === "optional") return next(undefined);
  sendJson(res, 401, { error: "unauthorized", message: "this request does not name a tenant" });
  req.resume();
}
