import { randomUUID } from "node:crypto";
import { CompactSign } from "jose";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";

export async function provisionTrustedAdmin(
  config: { core: string; signingSecret: string; identitySecret: string; org: string; issuer: string },
  subject: string,
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
    headers: signedHeaders(config.signingSecret, "POST", path, body),
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Trusted administrator provisioning failed");
}
