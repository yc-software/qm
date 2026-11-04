import { resendMailer, type Mailer } from "../../plugins/chassis/src/resend.ts";
import { tenantEnv } from "./settings.ts";

export function tenantMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return resendMailer(
    () => tenantEnv("RESEND_API_KEY") ?? apiKey,
    () => tenantEnv("AUTH_EMAIL_FROM") ?? from,
    fetchImpl,
  );
}
