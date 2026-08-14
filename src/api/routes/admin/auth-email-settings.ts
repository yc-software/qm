import {
  authEmailProblems,
  normalizeAuthEmailSettings,
  type AuthEmailAccess,
  type AuthEmailSettings,
  type SmtpTlsMode,
} from "../../../../plugins/chassis/src/auth-email.ts";
import { AuthEmailSettingsConflict } from "../../../auth/email-settings.ts";
import {
  AuthEmailServiceError,
  createAuthEmailServiceClient,
  type AuthEmailServiceStatus,
} from "../../../auth/email-service-client.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";

function service(ctx: ApiCtx) {
  if (!ctx.deps.authServiceUrl) return null;
  return createAuthEmailServiceClient({
    baseUrl: ctx.deps.authServiceUrl,
    signingSecret: ctx.deps.signingSecret,
    ...(ctx.deps.authServiceFetch ? { fetchImpl: ctx.deps.authServiceFetch } : {}),
  });
}

async function runtimeStatus(
  ctx: ApiCtx,
): Promise<AuthEmailServiceStatus | { state: "unreachable"; source: "absent" }> {
  const client = service(ctx);
  if (!client) return { state: "unreachable", source: "absent" };
  try {
    return await client.status();
  } catch {
    return { state: "unreachable", source: "absent" };
  }
}

function accessFrom(value: unknown): AuthEmailAccess | null {
  if (!isObj(value)) return null;
  if (value.mode === "emails" && Array.isArray(value.emails)) {
    return { mode: "emails", emails: value.emails.filter((email): email is string => typeof email === "string") };
  }
  if (value.mode === "domain" && typeof value.domain === "string") {
    return { mode: "domain", domain: value.domain };
  }
  return null;
}

function candidateFrom(ctx: ApiCtx, current: AuthEmailSettings | null): AuthEmailSettings | null {
  const body = isObj(ctx.body) ? ctx.body : {};
  const transport = body.transport;
  const from = typeof body.from === "string" ? body.from : "";
  const access = accessFrom(body.access);
  if ((transport !== "smtp" && transport !== "resend") || !access) return null;
  if (transport === "smtp") {
    const smtp = isObj(body.smtp) ? body.smtp : {};
    const tls = smtp.tls as SmtpTlsMode;
    const candidate = normalizeAuthEmailSettings({
      transport,
      from,
      access,
      smtp: {
        host: typeof smtp.host === "string" ? smtp.host : "",
        port: typeof smtp.port === "number" ? smtp.port : Number(smtp.port),
        tls: tls === "implicit" || tls === "none" ? tls : "starttls",
        username: typeof smtp.username === "string" ? smtp.username : "",
        password: typeof smtp.password === "string" ? smtp.password : "",
      },
    });
    if (candidate.transport !== "smtp") return null;
    if (candidate.smtp.password || current?.transport !== "smtp") return candidate;
    const sameConnection =
      candidate.smtp.host === current.smtp.host &&
      candidate.smtp.port === current.smtp.port &&
      candidate.smtp.tls === current.smtp.tls &&
      candidate.smtp.username === current.smtp.username;
    return sameConnection ? { ...candidate, smtp: { ...candidate.smtp, password: current.smtp.password } } : candidate;
  }
  const resend = isObj(body.resend) ? body.resend : {};
  const retained = current?.transport === "resend" ? current.resend.apiKey : "";
  return normalizeAuthEmailSettings({
    transport,
    from,
    access,
    resend: { apiKey: typeof resend.apiKey === "string" && resend.apiKey ? resend.apiKey : retained },
  });
}

export async function getAuthEmailSettings(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.authEmailSettings) return sendJson(ctx.res, 404, { error: "not_configured" });
  const [stored, runtime] = await Promise.all([ctx.deps.authEmailSettings.status(), runtimeStatus(ctx)]);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "auth-email-settings.read",
    resource: "auth-email-settings",
    scopeLabel: scope,
  });
  const configured = stored.source === "admin" ? stored.configured : runtime.state === "ready";
  return sendJson(ctx.res, 200, { ...stored, configured, runtime });
}

export async function putAuthEmailSettings(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.authEmailSettings) return sendJson(ctx.res, 404, { error: "not_configured" });
  const client = service(ctx);
  if (!client) return sendJson(ctx.res, 503, { error: "auth_service_not_configured" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const expectedVersion =
    body.expectedVersion === null || typeof body.expectedVersion === "string" ? body.expectedVersion : undefined;
  if (expectedVersion === undefined) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "expectedVersion must be a string or null" });
  }
  const snapshot = await ctx.deps.authEmailSettings.snapshot();
  if ((snapshot.status.version ?? null) !== expectedVersion) {
    return sendJson(ctx.res, 409, { error: "conflict", message: "email settings changed; reload before saving" });
  }
  const candidate = candidateFrom(ctx, snapshot.current?.settings ?? null);
  if (!candidate) return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid email settings" });
  const problems = authEmailProblems(candidate, ctx.deps.production === true);
  if (problems.length) return sendJson(ctx.res, 400, { error: "invalid_email_settings", message: problems.join("; ") });
  try {
    await client.validate(candidate, actor.id);
    const status = await ctx.deps.authEmailSettings.set(candidate, actor.id, expectedVersion);
    audit(ctx.deps, {
      principalId: actor.id,
      action: "auth-email-settings.update",
      resource: candidate.transport,
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, { ...status, runtime: await runtimeStatus(ctx) });
  } catch (error) {
    if (error instanceof AuthEmailSettingsConflict) {
      return sendJson(ctx.res, 409, { error: "conflict", message: error.message });
    }
    if (error instanceof AuthEmailServiceError) {
      const status = error.status >= 500 ? 502 : 400;
      return sendJson(ctx.res, status, { error: "email_validation_failed", message: error.message });
    }
    throw error;
  }
}
