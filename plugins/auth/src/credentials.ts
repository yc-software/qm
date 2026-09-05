import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { errMessage } from "../../chassis/src/errors.ts";

/**
 * The password half of the broker.
 *
 * The broker holds no database and no hash. It sends the identifier and the
 * password it was given over the signed source-auth channel and receives a
 * verdict. Core owns the credential, the rate limiter, and the decision.
 */
export type PasswordVerdict =
  | { ok: true; principalId: string; mustChange: boolean }
  | { ok: false }
  /** Core could not be reached or refused to answer: never treat as a pass. */
  | { ok: false; unavailable: true };

export interface PasswordChecker {
  verify(args: { identifier: string; password: string; ip: string }): Promise<PasswordVerdict>;
  change(args: { identifier: string; password: string; next: string; ip: string }): Promise<PasswordVerdict>;
}

const TIMEOUT_MS = 8_000;

export function corePasswordChecker(
  coreApiUrl: string,
  signingSecret: string | undefined,
  label = "auth",
): PasswordChecker {
  async function call(route: string, payload: Record<string, unknown>): Promise<PasswordVerdict> {
    const path = withSourceAuthNonce(`/v1/auth/broker/password/${route}`, signingSecret);
    const body = JSON.stringify(payload);
    try {
      const r = await fetch(`${coreApiUrl}${path}`, {
        method: "POST",
        headers: signedHeaders(signingSecret, "POST", path, body),
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) {
        console.error(`[${label}] core refused a password ${route}: HTTP ${r.status}`);
        return { ok: false, unavailable: true };
      }
      const parsed = (await r.json()) as { ok?: unknown; principalId?: unknown; mustChange?: unknown };
      if (parsed.ok !== true || typeof parsed.principalId !== "string") return { ok: false };
      return { ok: true, principalId: parsed.principalId, mustChange: parsed.mustChange === true };
    } catch (e) {
      console.error(`[${label}] password ${route} failed: ${errMessage(e)}`);
      return { ok: false, unavailable: true };
    }
  }

  return {
    verify: ({ identifier, password, ip }) => call("verify", { identifier, password, ip }),
    change: ({ identifier, password, next, ip }) => call("change", { identifier, password, next, ip }),
  };
}
