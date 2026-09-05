import { createHmac } from "node:crypto";
import { breakGlassCovers, breakGlassSecretMatches } from "../../auth/break-glass.ts";
import { passwordProblem } from "../../auth/password-credentials.ts";
import { personKey } from "../../directory/person.ts";
import { headerValue, sendJson } from "../http.ts";
import { audit, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const MAX_IDENTIFIER_LENGTH = 254;
const MAX_PASSWORD_BYTES = 1024;

/** Attempts allowed per identifier and per client address inside one window. */
const ATTEMPT_WINDOW_S = 900;
const ATTEMPTS_PER_IDENTIFIER = 10;
const ATTEMPTS_PER_IP = 50;
const BREAK_GLASS_ATTEMPTS_PER_IP = 5;

interface Attempt {
  identifier: string;
  password: string;
  ip: string;
}

function readAttempt(body: unknown): Attempt | null {
  const b = isObj(body) ? body : {};
  const identifier = typeof b.identifier === "string" ? b.identifier.trim() : "";
  const password = typeof b.password === "string" ? b.password : "";
  const ip = typeof b.ip === "string" && b.ip.trim() ? b.ip.trim().slice(0, 64) : "unknown";
  if (!identifier || identifier.length > MAX_IDENTIFIER_LENGTH) return null;
  if (!password || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return null;
  return { identifier, password, ip };
}

/**
 * A window-and-slot limiter over the durable replay store: the first `limit`
 * attempts in a window each claim a slot, and the attempt after that finds
 * none free. Slots are keyed by an HMAC so the store never holds the
 * identifier itself.
 */
async function withinLimit(ctx: ApiCtx, kind: string, value: string, limit: number, nowMs: number): Promise<boolean> {
  const dedupe = ctx.deps.replayDedupe;
  if (!dedupe) return false;
  const secret = ctx.deps.signingSecret ?? ctx.deps.capabilitySecret ?? "qm-password-limiter";
  const window = Math.floor(nowMs / (ATTEMPT_WINDOW_S * 1000));
  const bucket = createHmac("sha256", secret).update(`password.v1|${kind}|${value}`, "utf8").digest("base64url");
  const expiresAtMs = (window + 1) * ATTEMPT_WINDOW_S * 1000;
  for (let slot = 0; slot < limit; slot++) {
    if (await dedupe.claim(`pwrate:${kind}:${bucket.slice(0, 22)}:${window}:${slot}`, expiresAtMs)) return true;
  }
  return false;
}

function passwordStoreOr404(ctx: ApiCtx): NonNullable<ApiCtx["deps"]["passwordCredentials"]> | null {
  const store = ctx.deps.passwordCredentials;
  if (!store) {
    // The deployment does not do password sign-in. The route does not exist
    // for it, rather than existing and refusing.
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  if (!ctx.deps.replayDedupe?.durable) {
    sendJson(ctx.res, 503, {
      error: "not_configured",
      message:
        "password verification needs the Postgres-backed replay store so a restart cannot reset the attempt limiter",
    });
    return null;
  }
  return store;
}

/**
 * A wrong password, an identifier with no account, a deactivated principal, and
 * a rate-limited attempt all answer the same way. Nothing here reveals who has
 * an account.
 *
 * One difference is deliberate and is not a leak. A rate-limited attempt
 * returns before the hash comparison, so it is measurably faster than a
 * password that was actually checked. What that timing reveals is whether the
 * *caller's own* attempts have exhausted a bucket — the limiter is keyed on the
 * identifier and the client address and behaves identically whether or not an
 * account exists, which `test/password-signin-routes.test.ts` asserts. Paying
 * the hash cost on a refused attempt would trade a non-leak for an
 * amplification vector: it would let an attacker force unbounded scrypt work
 * precisely when the limiter has decided to stop doing any.
 */
const refuse = (ctx: ApiCtx): void => sendJson(ctx.res, 200, { ok: false });

async function verifyPassword(ctx: ApiCtx): Promise<void> {
  const store = passwordStoreOr404(ctx);
  if (!store) return;
  const attempt = readAttempt(ctx.body);
  if (!attempt)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "identifier and password are required" });
  const now = Date.now();
  if (!(await withinLimit(ctx, "ip", attempt.ip, ATTEMPTS_PER_IP, now))) return refuse(ctx);
  if (!(await withinLimit(ctx, "identifier", personKey(attempt.identifier), ATTEMPTS_PER_IDENTIFIER, now)))
    return refuse(ctx);

  const verdict = await store.verify(attempt.identifier, attempt.password);
  if (!verdict.ok) return refuse(ctx);

  // A deactivated principal has no way in, whatever their password says. This
  // reads the durable record rather than the replica's cache: `refresh()` is
  // throttled, so a cached answer can be up to `REFRESH_TTL_MS` stale and this
  // is an admission decision, not a decoration.
  let principal: { type: string } | undefined;
  try {
    principal = await ctx.deps.identity?.classifyFresh(verdict.principalId);
  } catch (e) {
    console.error(`[password] deactivation lookup failed: ${String(e)}`);
    return refuse(ctx);
  }
  if (principal && principal.type !== "internal") {
    audit(ctx.deps, {
      principalId: verdict.principalId,
      action: "password.refused",
      resource: verdict.principalId,
      scopeLabel: orgScope(ctx.deps),
      status: "deactivated",
    });
    return refuse(ctx);
  }
  audit(ctx.deps, {
    principalId: verdict.principalId,
    action: "password.verified",
    resource: verdict.principalId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, {
    ok: true,
    principalId: verdict.principalId,
    mustChange: verdict.mustChange,
  });
}

async function changePassword(ctx: ApiCtx): Promise<void> {
  const store = passwordStoreOr404(ctx);
  if (!store) return;
  const attempt = readAttempt(ctx.body);
  const b = isObj(ctx.body) ? ctx.body : {};
  const next = typeof b.next === "string" ? b.next : "";
  if (!attempt)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "identifier and password are required" });
  const problem = passwordProblem(next);
  if (problem) return sendJson(ctx.res, 400, { error: "weak_password", message: problem });
  const now = Date.now();
  if (!(await withinLimit(ctx, "ip", attempt.ip, ATTEMPTS_PER_IP, now))) return refuse(ctx);
  if (!(await withinLimit(ctx, "identifier", personKey(attempt.identifier), ATTEMPTS_PER_IDENTIFIER, now)))
    return refuse(ctx);

  try {
    const before = await ctx.deps.identity?.classifyFresh(attempt.identifier);
    if (before && before.type !== "internal") return refuse(ctx);
  } catch (e) {
    console.error(`[password] deactivation lookup failed: ${String(e)}`);
    return refuse(ctx);
  }

  const verdict = await store.change(attempt.identifier, attempt.password, next);
  if (!verdict.ok) return refuse(ctx);
  audit(ctx.deps, {
    principalId: verdict.principalId,
    action: "password.changed",
    resource: verdict.principalId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, principalId: verdict.principalId, mustChange: false });
}

/**
 * Restore administrator access to a deployment whose sign-in transport is
 * unusable. Configured only at boot; unconfigured, it answers 404 like any
 * route that does not exist.
 */
async function breakGlassRecover(ctx: ApiCtx): Promise<void> {
  const { res, deps, req } = ctx;
  const cfg = deps.breakGlass;
  if (!cfg) return sendJson(res, 404, { error: "not_found" });
  const store = passwordStoreOr404(ctx);
  if (!store) return;

  const ip = headerValue(req, "x-qm-client-ip") || req.socket.remoteAddress || "unknown";
  if (!(await withinLimit(ctx, "breakglass-ip", ip, BREAK_GLASS_ATTEMPTS_PER_IP, Date.now()))) {
    // Audited like any other refusal: repeated attempts against this route are
    // exactly what an operator would want to see afterwards.
    audit(deps, {
      principalId: cfg.principalId,
      action: "break-glass.refused",
      resource: cfg.principalId,
      scopeLabel: orgScope(deps),
      status: "rate-limited",
      detail: `from ${ip}`,
    });
    return sendJson(res, 429, { error: "too_many_attempts" });
  }

  const header = headerValue(req, "authorization") ?? "";
  const offered = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  const b = isObj(ctx.body) ? ctx.body : {};
  const principalId = typeof b.principalId === "string" ? b.principalId.trim() : "";
  const password = typeof b.password === "string" ? b.password : "";
  const failed = (why: string): void => {
    audit(deps, {
      principalId: cfg.principalId,
      action: "break-glass.refused",
      resource: principalId || cfg.principalId,
      scopeLabel: orgScope(deps),
      status: why,
      detail: `from ${ip}`,
    });
    sendJson(res, 403, { error: "forbidden" });
  };
  if (!offered || !breakGlassSecretMatches(cfg, offered)) return failed("bad-secret");
  if (!principalId || !breakGlassCovers(cfg, principalId)) return failed("not-covered");
  const problem = passwordProblem(password);
  if (problem) return sendJson(res, 400, { error: "weak_password", message: problem });

  // Put the named principal back: a member row, an active identity, a
  // credential they must change immediately, and their administrator grant.
  await deps.directory?.upsertMember({ principalId, displayName: principalId, type: "internal" });
  await deps.identity?.reactivate(principalId);
  await store.set(principalId, password, "break-glass", true);
  // Restoring the grant is the point. Reporting success without it would tell
  // an operator mid-incident that they can get in when they cannot, so a
  // failure here is a failed recovery, not a warning.
  try {
    await deps.admin?.forceGrantOrgAdmin(principalId, "break-glass");
  } catch (e) {
    audit(deps, {
      principalId,
      action: "break-glass.recover",
      resource: principalId,
      scopeLabel: orgScope(deps),
      status: "partial",
      detail: `password set but the org_admin grant failed, from ${ip}`,
    });
    console.error(`[break-glass] password set for ${principalId} but the admin grant failed: ${String(e)}`);
    return sendJson(res, 500, {
      error: "grant_failed",
      message:
        "the password was set but the org_admin grant could not be written — that account can sign in but cannot administer",
    });
  }
  audit(deps, {
    principalId,
    action: "break-glass.recover",
    resource: principalId,
    scopeLabel: orgScope(deps),
    status: "ok",
    detail: `from ${ip}`,
  });
  console.warn(`[break-glass] administrator access restored for ${principalId} from ${ip}`);
  return sendJson(res, 200, { ok: true, mustChange: true });
}

export const passwordRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/broker/password/verify", auth: "source", handle: verifyPassword },
  { method: "POST", path: "/v1/auth/broker/password/change", auth: "source", handle: changePassword },
  // Source-authenticated like every other core route, and additionally gated
  // by the boot-time break-glass secret. Recovery therefore needs both, and
  // the operator running it has both: they are on the host, in the .env this
  // deployment already reads. `scripts/break-glass.ts` signs the call.
  { method: "POST", path: "/v1/auth/break-glass", auth: "source", handle: breakGlassRecover },
];
