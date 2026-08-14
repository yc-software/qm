import { signedHeaders, withSourceAuthNonce } from "../../plugins/chassis/src/core-client.ts";
import type { AuthEmailSettings } from "../../plugins/chassis/src/auth-email.ts";

export interface AuthEmailServiceStatus {
  state: "ready" | "unconfigured" | "degraded";
  source: "admin" | "environment" | "absent";
  activeVersion?: string;
  message?: string;
}

export interface AuthEmailServiceClient {
  status(): Promise<AuthEmailServiceStatus>;
  validate(settings: AuthEmailSettings, recipient: string): Promise<void>;
  validateEnvironment(recipient: string): Promise<void>;
}

export class AuthEmailServiceError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthEmailServiceError";
    this.status = status;
  }
}

export function createAuthEmailServiceClient(input: {
  baseUrl: string;
  signingSecret: string | undefined;
  fetchImpl?: typeof fetch;
}): AuthEmailServiceClient {
  const request = async <T>(method: "GET" | "POST", path: string, value: unknown, timeoutMs: number): Promise<T> => {
    const target = withSourceAuthNonce(path, input.signingSecret);
    const body = value === undefined ? "" : JSON.stringify(value);
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(`${input.baseUrl}${target}`, {
        method,
        headers: signedHeaders(input.signingSecret, method, target, body),
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AuthEmailServiceError("auth email service is unavailable", 502);
    }
    if (!response.ok) {
      throw new AuthEmailServiceError("auth email service rejected the request", response.status);
    }
    return (await response.json().catch(() => ({}))) as T;
  };
  return {
    async status() {
      const { message, ...status } = await request<AuthEmailServiceStatus>(
        "GET",
        "/internal/email-settings/status",
        undefined,
        5_000,
      );
      return message ? { ...status, message: "auth email runtime reported a degraded state" } : status;
    },
    async validate(settings, recipient) {
      await request("POST", "/internal/email-settings/validate", { settings, recipient }, 40_000);
    },
    async validateEnvironment(recipient) {
      await request("POST", "/internal/email-settings/validate-environment", { recipient }, 40_000);
    },
  };
}
