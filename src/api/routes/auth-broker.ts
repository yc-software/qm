import { createHash } from "node:crypto";
import { verifySignedPayload } from "../../auth/signed-token.ts";
import { AdminError } from "../../admin/admin-service.ts";
import { sendJson } from "../http.ts";
import { deployRef, encodeRef } from "../../acl/resource-ref.ts";
import { externalMemberActive, validEmail } from "../../identity/external-members.ts";
import { isObj, authorizeAdmin, orgScope, audit, activePrincipal } from "./shared.ts";
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
  const { res, deps, app, url } = ctx;
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!validEmail(email)) return sendJson(res, 400, { error: "bad_request", message: "email required" });
  if (!deps.identity) return sendJson(res, 200, { allowed: false });
  await deps.identity.refresh();
  if (deps.identity.deactivationSource(email) === "manual") return sendJson(res, 200, { allowed: false });
  const member = deps.identity.externalMember(email);
  const configured =
    deps.emailAuthPrincipals?.includes(email) ||
    Boolean(deps.emailAuthDomain && email.endsWith(`@${deps.emailAuthDomain}`));
  const allowed =
    deps.identity.classify(email).type === "internal" && (member ? externalMemberActive(member) : configured);
  if (allowed) return sendJson(res, 200, { allowed: true, expiresAt: member?.expiresAt });
  const grants = (await deps.acl?.list()) ?? [];
  const deployments = await app.listDeployments();
  const appOnly = deployments.some(
    (d) =>
      d.status !== "archived" &&
      grants.some(
        (g) =>
          g.ownerScopeId === d.ownerScopeId &&
          g.ref === encodeRef(deployRef(d.id)) &&
          g.granteeScopeId === `personal:${email}` &&
          g.permission === "read",
      ),
  );
  return sendJson(res, 200, appOnly ? { allowed: true, appOnly: true } : { allowed: false });
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

async function trustedAdmin(ctx: ApiCtx): Promise<void> {
  const { deps, res, body } = ctx;
  const secret = deps.portalIdentitySecret;
  if (!secret || secret.length < 32 || secret === ctx.secret || !deps.admin || !deps.replayDedupe?.durable)
    return sendJson(res, 503, { error: "not_configured" });
  const assertion = isObj(body) && typeof body.assertion === "string" ? body.assertion : "";
  const claims = await verifySignedPayload(assertion, secret);
  const now = Date.now();
  if (
    !isObj(claims) ||
    claims.purpose !== "trusted-entry-admin" ||
    claims.org !== orgScope() ||
    typeof claims.issuer !== "string" ||
    typeof claims.subject !== "string" ||
    !claims.subject ||
    claims.subject.length > 255 ||
    claims.imp !== undefined ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    claims.exp > now + 60_000 ||
    typeof claims.jti !== "string" ||
    !/^[a-f0-9-]{36}$/.test(claims.jti)
  )
    return sendJson(res, 403, { error: "invalid_assertion" });
  const principalId = `oidc:${createHash("sha256").update(claims.issuer).digest("hex")}:${Buffer.from(claims.subject).toString("base64url")}`;
  if (!(await activePrincipal(deps, principalId))) return sendJson(res, 403, { error: "inactive_principal" });
  if (!(await deps.replayDedupe.claim(`trusted-admin:${claims.jti}`, claims.exp)))
    return sendJson(res, 409, { error: "assertion_already_used" });
  try {
    const { grant, created } = await deps.admin.provisionTrustedEntry(claims.issuer, claims.subject);
    if (created)
      audit(deps, {
        principalId: grant.grantedBy!,
        action: "grant.create",
        resource: `${grant.principalId}/org_admin`,
        scopeLabel: grant.scopeId,
      });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof AdminError)
      return sendJson(res, error.status, { error: "grant_failed", message: error.message });
    throw error;
  }
}

async function redeemInvitation(ctx: ApiCtx): Promise<void> {
  const { deps, res, body } = ctx;
  if (!deps.portalIdentitySecret || !deps.replayDedupe?.durable || !deps.identity || !deps.portalUrl)
    return sendJson(res, 503, { error: "not_configured" });
  const token = isObj(body) && typeof body.token === "string" ? body.token : "";
  const claims = token.length <= 4096 ? await verifySignedPayload(token, deps.portalIdentitySecret) : null;
  const now = Date.now();
  if (
    !isObj(claims) ||
    claims.purpose !== "teammate-invite" ||
    claims.org !== orgScope(deps) ||
    claims.aud !== deps.portalUrl.replace(/\/+$/, "") ||
    typeof claims.email !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.iat > now + 5000 ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 86400000 ||
    typeof claims.jti !== "string" ||
    !/^[a-f0-9-]{36}$/.test(claims.jti)
  )
    return sendJson(res, 400, { error: "invalid_invitation" });
  await deps.identity.refresh(true);
  const member = deps.identity.externalMember(claims.email);
  if (
    !member ||
    member.kind !== "teammate" ||
    !member.inviteId ||
    member.inviteId !== claims.inviteId ||
    !externalMemberActive(member) ||
    deps.identity.classify(claims.email).type !== "internal"
  )
    return sendJson(res, 403, { error: "invitation_revoked" });
  if (!(await deps.replayDedupe.claim(`teammate-invite:${claims.jti}`, claims.exp)))
    return sendJson(res, 400, { error: "invitation_used" });
  audit(deps, {
    principalId: claims.email,
    action: "user.invite.redeem",
    resource: claims.email,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { email: claims.email });
}

export const authBrokerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/invitations/redeem", auth: "source", handle: redeemInvitation },
  { method: "POST", path: "/v1/auth/trusted/admin", auth: "source", handle: trustedAdmin },
  { method: "POST", path: "/v1/auth/broker/sessions", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/sessions/use", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/sessions/revoke", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/claim", auth: "source", handle: claimBrokerNonce },
  { method: "GET", path: "/v1/auth/broker/email-allowed", auth: "source", handle: emailAllowed },
];
