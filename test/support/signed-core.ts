import { signedRequestHeaders, TENANT_HEADER } from "../../plugins/chassis/src/source-auth-sign.ts";
import { withTenant as withChassisTenant } from "../../plugins/chassis/src/tenant.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";
import { signedHeaders as chassisSignedHeaders } from "../../plugins/chassis/src/core-client.ts";
import {
  coreEmailAdmission as chassisEmailAdmission,
  coreEmailAllowed as chassisEmailAllowed,
} from "../../plugins/chassis/src/external-members.ts";
import { TEST_TENANT } from "./tenant.ts";

export interface SignedCoreOptions {
  actor?: string;
  identitySecret?: string;
  identityTenant?: string;
  tenant?: string;
  headers?: Record<string, string>;
}

export async function signedCoreHeaders(
  secret: string,
  method: string,
  pathWithQuery: string,
  body = "",
  opts: SignedCoreOptions = {},
): Promise<Record<string, string>> {
  const tenant = opts.tenant ?? TEST_TENANT;
  const base: Record<string, string> = { ...opts.headers, [TENANT_HEADER]: tenant };
  if (opts.actor)
    base[PORTAL_IDENTITY_HEADER] = await mintPortalIdentity(
      { t: opts.identityTenant ?? tenant, p: opts.actor, exp: Date.now() + 60_000 },
      opts.identitySecret ?? secret,
    );
  return signedRequestHeaders(secret, method, pathWithQuery, body, base);
}

export function inChassisTenant<A extends unknown[], R>(
  fn: (...args: A) => R,
  tenant = TEST_TENANT,
): (...args: A) => R {
  return (...args) => withChassisTenant(tenant, () => fn(...args));
}

let clock = 0;

export function signedFetcher(secret: string, tenant = TEST_TENANT): typeof fetch {
  return (input, init = {}) => {
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    if (headers["x-signature"]) return fetch(input, init);
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? init.body : "";
    const nowSec = Math.floor(Date.now() / 1000) - 240 + (clock++ % 480);
    const signed = signedRequestHeaders(
      secret,
      init.method ?? "GET",
      url.pathname + url.search,
      body,
      { [TENANT_HEADER]: tenant, ...headers },
      nowSec,
    );
    return fetch(input, { ...init, headers: signed });
  };
}

export const signedHeaders = inChassisTenant(chassisSignedHeaders);
export const coreEmailAdmission = inChassisTenant(chassisEmailAdmission);
export const coreEmailAllowed = inChassisTenant(chassisEmailAllowed);
