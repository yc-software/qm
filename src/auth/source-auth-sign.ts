import { signedRequestHeaders as signHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { currentTenant } from "../tenancy/context.ts";

export { canonicalPayload, signRequest } from "../../plugins/chassis/src/source-auth-sign.ts";

export function signedRequestHeaders(
  secret: string | undefined,
  method: string,
  pathWithQuery: string,
  body = "",
  base: Record<string, string> = {},
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const tenant = currentTenant();
  return signHeaders(secret, method, pathWithQuery, body, base, nowSec, tenant?.pooled ? tenant.id : undefined);
}
