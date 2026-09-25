import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { errMessage } from "./errors.ts";

const EMAIL_ALLOWED_PATH = "/v1/auth/broker/email-allowed";
const EMAIL_ALLOWED_TIMEOUT_MS = 4_000;

export interface EmailAdmission {
  allowed: boolean;
  appOnly?: true;
}

export async function coreEmailAdmission(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
  label = "chassis",
): Promise<EmailAdmission> {
  const path = withSourceAuthNonce(`${EMAIL_ALLOWED_PATH}?email=${encodeURIComponent(email)}`, signingSecret);
  try {
    const r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(EMAIL_ALLOWED_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.error(`[${label}] core refused an external-member lookup: HTTP ${r.status}`);
      return { allowed: false };
    }
    const parsed = (await r.json()) as { allowed?: unknown; appOnly?: unknown };
    if (parsed.allowed !== true || (parsed.appOnly !== undefined && typeof parsed.appOnly !== "boolean"))
      return { allowed: false };
    return { allowed: true, ...(parsed.appOnly === true ? { appOnly: true } : {}) };
  } catch (e) {
    console.error(`[${label}] core external-member lookup failed: ${errMessage(e)}`);
    return { allowed: false };
  }
}

export async function coreEmailAllowed(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
  label = "chassis",
): Promise<boolean> {
  return (await coreEmailAdmission(coreApiUrl, signingSecret, email, label)).allowed;
}
