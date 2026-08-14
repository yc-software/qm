import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";
import { authEmailProblems, emailAllowed, validEmail, type AuthEmailSettings } from "../../chassis/src/auth-email.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import { environmentEmailProblems, environmentEmailSettings, type AuthConfig } from "./config.ts";
import { mailerFor, type Mailer } from "./email.ts";

export interface ActiveAuthEmail {
  settings: AuthEmailSettings;
  mailer: Mailer;
  source: "admin" | "environment";
  version: string;
}

export interface AuthEmailRuntimeStatus {
  state: "ready" | "unconfigured" | "degraded";
  source: "admin" | "environment" | "absent";
  activeVersion?: string;
  message?: string;
}

export function redactAuthEmailError(error: unknown, settings: AuthEmailSettings | null): string {
  let message = errMessage(error, "email operation failed");
  let secrets: string[] = [];
  if (settings?.transport === "smtp") secrets = [settings.smtp.password];
  else if (settings?.transport === "resend") secrets = [settings.resend.apiKey];
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  return message;
}

interface RuntimeResponse {
  managed?: boolean;
  active?: boolean;
  version?: string;
  settings?: AuthEmailSettings;
}

export class AuthEmailRuntime {
  private readonly input: {
    cfg: AuthConfig;
    production: boolean;
    coreApiUrl: string;
    signingSecret: string | undefined;
    fetchImpl?: typeof fetch;
    mailerFactory?: (settings: AuthEmailSettings) => Mailer;
    pollMs?: number;
  };
  private active: ActiveAuthEmail | null;
  private timer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private message: string | undefined;
  private readonly environment: AuthEmailSettings | null;

  constructor(input: {
    cfg: AuthConfig;
    production: boolean;
    coreApiUrl: string;
    signingSecret: string | undefined;
    fetchImpl?: typeof fetch;
    mailerFactory?: (settings: AuthEmailSettings) => Mailer;
    pollMs?: number;
  }) {
    this.input = input;
    const environment = environmentEmailSettings(input.cfg);
    this.environment =
      environment && !environmentEmailProblems(input.cfg, input.production).length ? environment : null;
    this.active = this.environment
      ? {
          settings: this.environment,
          mailer: this.mailer(this.environment),
          source: "environment",
          version: "environment",
        }
      : null;
  }

  private mailer(settings: AuthEmailSettings): Mailer {
    return (this.input.mailerFactory ?? mailerFor)(settings);
  }

  current(): ActiveAuthEmail | null {
    return this.active;
  }

  status(): AuthEmailRuntimeStatus {
    if (!this.active) {
      return {
        state: "unconfigured",
        source: "absent",
        ...(this.message ? { message: this.message } : {}),
      };
    }
    return {
      state: this.message ? "degraded" : "ready",
      source: this.active.source,
      activeVersion: this.active.version,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.refreshOnce().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private async refreshOnce(): Promise<void> {
    const path = withSourceAuthNonce("/v1/auth/email-settings/runtime", this.input.signingSecret);
    let candidate: AuthEmailSettings | null = null;
    try {
      const response = await (this.input.fetchImpl ?? fetch)(`${this.input.coreApiUrl}${path}`, {
        headers: signedHeaders(this.input.signingSecret, "GET", path),
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) throw new Error(`core returned HTTP ${response.status}`);
      const payload = (await response.json()) as RuntimeResponse;
      if (payload.managed && payload.active) {
        if (!payload.settings || !payload.version) throw new Error("core returned incomplete managed email settings");
        candidate = payload.settings;
        const problems = authEmailProblems(payload.settings, this.input.production);
        if (problems.length) throw new Error(problems.join("; "));
        if (this.active?.source !== "admin" || this.active.version !== payload.version) {
          this.active = {
            settings: payload.settings,
            mailer: this.mailer(payload.settings),
            source: "admin",
            version: payload.version,
          };
        }
      } else if (this.environment) {
        this.active = {
          settings: this.environment,
          mailer: this.mailer(this.environment),
          source: "environment",
          version: "environment",
        };
      } else {
        this.active = null;
      }
      this.message = undefined;
    } catch (error) {
      this.message = redactAuthEmailError(error, candidate);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.input.pollMs ?? 2_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async validate(settings: AuthEmailSettings, recipient: string): Promise<{ message: string }> {
    const problems = authEmailProblems(settings, this.input.production);
    if (problems.length) throw new Error(problems.join("; "));
    const normalizedRecipient = recipient.trim().toLowerCase();
    if (!validEmail(normalizedRecipient))
      throw new Error("the current administrator principal is not an email address");
    if (!emailAllowed(settings, normalizedRecipient))
      throw new Error("the current administrator must remain allowed to sign in");
    const mailer = this.mailer(settings);
    const verified = await mailer.verify();
    await mailer.send({
      to: normalizedRecipient,
      subject: `${this.input.cfg.brandName} sign-in email test`,
      text: `Email delivery for ${this.input.cfg.brandName} is ready.`,
      html: `<p>Email delivery for ${this.input.cfg.brandName} is ready.</p>`,
    });
    return { message: verified };
  }

  async validateEnvironment(recipient: string): Promise<{ message: string }> {
    if (!this.environment) throw new Error("deployment email settings are not valid");
    return this.validate(this.environment, recipient);
  }
}
