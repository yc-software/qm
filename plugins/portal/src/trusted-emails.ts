import { randomUUID } from "node:crypto";
import { CompactSign } from "jose";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";

export interface EmailLinkResult {
  linked: number;
  unchanged: number;
  skipped: Record<string, number>;
}

/**
 * Asks core to join the email identities a trusted provider verified for this subject to the
 * subject's principal in the tenant the sign-in lands in. The single-use assertion is signed
 * with the portal identity secret, so a surface holding only the core signing secret cannot
 * request links.
 */
export async function linkTrustedEmails(
  config: {
    core: string;
    signingSecret: string;
    identitySecret: string;
    org: string;
    issuer: string;
    headers?: Record<string, string>;
  },
  subject: string,
  emails: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<EmailLinkResult | null> {
  const claims = {
    purpose: "trusted-entry-emails",
    issuer: config.issuer,
    subject,
    emails: [...emails],
    org: `org:${config.org}`,
    exp: Date.now() + 60_000,
    jti: randomUUID(),
  };
  const assertion = await new CompactSign(Buffer.from(JSON.stringify(claims)))
    .setProtectedHeader({ alg: "HS256" })
    .sign(Buffer.from(config.identitySecret));
  const path = withSourceAuthNonce("/v1/auth/trusted/emails", config.signingSecret);
  const body = JSON.stringify({ assertion });
  const response = await fetchImpl(`${config.core}${path}`, {
    method: "POST",
    headers: { ...signedHeaders(config.signingSecret, "POST", path, body), ...config.headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Email linking failed: HTTP ${response.status}`);
  return (await response.json()) as EmailLinkResult;
}
