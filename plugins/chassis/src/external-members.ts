import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { errMessage } from "./errors.ts";

const EMAIL_ALLOWED_PATH = "/v1/auth/broker/email-allowed";
const EMAIL_ALLOWED_TIMEOUT_MS = 4_000;

export async function coreEmailAllowed(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
  label = "chassis",
): Promise<boolean> {
  const path = withSourceAuthNonce(`${EMAIL_ALLOWED_PATH}?email=${encodeURIComponent(email)}`, signingSecret);
  try {
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(EMAIL_ALLOWED_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.error(`[${label}] core refused an external-member lookup: HTTP ${r.status}`);
      return false;
    }
    const parsed = (await r.json()) as { allowed?: unknown };
    return parsed.allowed === true;
  } catch (e) {
    console.error(`[${label}] core external-member lookup failed: ${errMessage(e)}`);
    return false;
  }
}
