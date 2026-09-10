import { sendJson } from "../http.ts";
import { externalMemberActive } from "../../identity/external-members.ts";
import { isObj, authorizeAdmin, orgScope, audit } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const NAMESPACE = "authbroker:";
const MAX_IDS = 64;
const MAX_ID_LENGTH = 200;
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;

async function claimBrokerNonce(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.replayDedupe?.durable) {
    return sendJson(res, 503, {
      error: "not_configured",
      message:
        "single-use claims need the Postgres-backed replay store; set DATABASE_URL so a restart cannot resurrect a spent sign-in link",
    });
  }
  const b = isObj(body) ? body : {};
  const ids: unknown[] = Array.isArray(b.ids) ? b.ids : [];
  if (
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH)
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `ids must hold 1 to ${MAX_IDS} non-empty strings of at most ${MAX_ID_LENGTH} characters`,
    });
  }
  const now = Date.now();
  const expiresAtMs = b.expiresAtMs;
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs > now + MAX_HORIZON_MS
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "expiresAtMs must be a future epoch-millisecond timestamp within 24 hours",
    });
  }
  for (const id of ids as string[]) {
    if (await deps.replayDedupe.claim(`${NAMESPACE}${id}`, expiresAtMs)) return sendJson(res, 200, { claimed: id });
  }
  return sendJson(res, 200, { claimed: null });
}

async function emailAllowed(ctx: ApiCtx): Promise<void> {
  const { res, deps, url } = ctx;
  const email = (url.searchParams.get("email") ?? "").trim();
  if (!email) return sendJson(res, 400, { error: "bad_request", message: "email required" });
  if (!deps.identity) return sendJson(res, 200, { allowed: false });
  await deps.identity.refresh();
  const member = deps.identity.externalMember(email);
  const allowed =
    member !== undefined && externalMemberActive(member) && deps.identity.classify(email).type === "internal";
  return sendJson(res, 200, { allowed, ...(allowed ? { expiresAt: member.expiresAt } : {}) });
}

async function brokerSession(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.brokerSessions) return sendJson(res, 503, { error: "not_configured" });
  const b = isObj(body) ? body : {};
  if (ctx.pathname.endsWith("/use")) {
    if (typeof b.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(b.token))
      return sendJson(res, 400, { error: "invalid_token" });
    return sendJson(res, 200, { session: await deps.brokerSessions.use(b.token) });
  }
  if (typeof b.email !== "string" || b.email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))
    return sendJson(res, 400, { error: "invalid_email" });
  const email = b.email.trim().toLowerCase();
  if (ctx.pathname.endsWith("/revoke")) {
    if (ctx.actor?.p.toLowerCase() !== email && !(await authorizeAdmin(ctx, orgScope()))) return;
    await deps.brokerSessions.revoke(email);
    audit(deps, {
      principalId: ctx.actor?.p ?? "admin",
      action: "auth.broker.revoke",
      resource: email,
      scopeLabel: orgScope(),
    });
    return sendJson(res, 200, { ok: true });
  }
  const idleS = b.idleS;
  const absoluteS = b.absoluteS;
  if (
    typeof idleS !== "number" ||
    typeof absoluteS !== "number" ||
    !Number.isInteger(idleS) ||
    !Number.isInteger(absoluteS) ||
    idleS < 1 ||
    absoluteS < idleS ||
    absoluteS > 90 * 86400
  )
    return sendJson(res, 400, { error: "invalid_lifetime" });
  return sendJson(res, 200, await deps.brokerSessions.create(email, idleS, absoluteS));
}

export const authBrokerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/broker/sessions", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/sessions/use", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/sessions/revoke", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/claim", auth: "source", handle: claimBrokerNonce },
  { method: "GET", path: "/v1/auth/broker/email-allowed", auth: "source", handle: emailAllowed },
];
