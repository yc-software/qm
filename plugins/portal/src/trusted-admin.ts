import { randomUUID } from "node:crypto";
import { CompactSign } from "jose";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { trustedPrincipal } from "./trusted-entry.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

export async function provisionTrustedAdmin(
  config: { core: string; signingSecret: string; identitySecret: string; org: string; issuer: string },
  subject: string,
  tenant?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const claims = {
    purpose: "trusted-entry-admin",
    issuer: config.issuer,
    subject,
    org: `org:${config.org}`,
    exp: Date.now() + 60_000,
    jti: randomUUID(),
  };
  const assertion = await new CompactSign(Buffer.from(JSON.stringify(claims)))
    .setProtectedHeader({ alg: "HS256" })
    .sign(Buffer.from(config.identitySecret));
  const path = withSourceAuthNonce("/v1/auth/trusted/admin", config.signingSecret);
  const body = JSON.stringify({ assertion });
  const response = await fetchImpl(`${config.core}${path}`, {
    method: "POST",
    headers: {
      ...signedHeaders(config.signingSecret, "POST", path, body),
      ...(tenant
        ? {
            [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
              { p: trustedPrincipal(config.issuer, subject), t: tenant, exp: Date.now() + 60_000 },
              config.identitySecret,
            ),
          }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Trusted administrator provisioning failed: HTTP ${response.status}`);
}
