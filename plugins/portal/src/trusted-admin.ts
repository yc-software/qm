import { randomUUID } from "node:crypto";
import { CompactSign } from "jose";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { isTenantId } from "../../chassis/src/tenant.ts";
import type { ExternalOrg } from "./tenant-choice.ts";

interface TrustedCoreConfig {
  core: string;
  signingSecret: string;
  identitySecret: string;
  org: string;
  issuer: string;
}

async function postAssertion(
  config: TrustedCoreConfig,
  route: string,
  claims: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const assertion = await new CompactSign(
    Buffer.from(
      JSON.stringify({
        ...claims,
        issuer: config.issuer,
        org: `org:${config.org}`,
        exp: Date.now() + 60_000,
        jti: randomUUID(),
      }),
    ),
  )
    .setProtectedHeader({ alg: "HS256" })
    .sign(Buffer.from(config.identitySecret));
  const path = withSourceAuthNonce(route, config.signingSecret);
  const body = JSON.stringify({ assertion });
  return fetchImpl(`${config.core}${path}`, {
    method: "POST",
    headers: signedHeaders(config.signingSecret, "POST", path, body),
    body,
    signal: AbortSignal.timeout(5_000),
  });
}

export async function selfServeWorkspace(
  config: TrustedCoreConfig,
  who: { subject: string; email: string | null },
  externalOrg: ExternalOrg,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await postAssertion(
    config,
    "/v1/auth/broker/self-serve",
    { purpose: "trusted-self-serve", subject: who.subject, email: who.email, externalOrg },
    fetchImpl,
  );
  if (!response.ok) throw new Error(`Self-serve workspace failed: HTTP ${response.status} ${await response.text()}`);
  const { tenant } = (await response.json()) as { tenant?: unknown };
  if (!isTenantId(tenant)) throw new Error("Self-serve workspace failed: no workspace returned");
  return tenant;
}

export async function provisionTrustedAdmin(
  config: TrustedCoreConfig,
  subject: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await postAssertion(
    config,
    "/v1/auth/trusted/admin",
    { purpose: "trusted-entry-admin", subject },
    fetchImpl,
  );
  if (!response.ok) throw new Error(`Trusted administrator provisioning failed: HTTP ${response.status}`);
}
