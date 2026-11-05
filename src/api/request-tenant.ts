import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCapabilityToken, type CapabilityClaims } from "../auth/capability-token.ts";
import { withTenant } from "../tenants/context.ts";
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
  return /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
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

export async function withRequestTenant(
  req: IncomingMessage,
  res: ServerResponse,
  route: Pick<Route, "auth" | "tenant"> | undefined,
  capabilitySecret: string | undefined,
  readBootTenant: () => Promise<string | undefined>,
  next: () => Promise<void> | void,
  ready?: () => Promise<void>,
): Promise<void> {
  if (route?.tenant === "none") return next();
  const token = capabilityToken(req, typeof route?.auth === "object" && route.auth.bearer === true);
  const claims = token ? await requestCapability(req, token, capabilitySecret) : null;
  const tenant = claims?.tenant ?? (await readBootTenant());
  if (tenant)
    return withTenant(tenant, async () => {
      await ready?.();
      return next();
    });
  sendJson(res, 401, { error: "unauthorized", message: "this request does not name a tenant" });
  req.resume();
}
