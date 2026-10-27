import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { createHash } from "node:crypto";
import { verifySignedPayload } from "../../auth/signed-token.ts";
import { AdminError } from "../../admin/admin-service.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { externalMemberActive, validEmail } from "../../identity/external-members.ts";
import { isObj, authorizeAdmin, audit, activePrincipal } from "./shared.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import { tenant } from "../../tenant.ts";

const NAMESPACE = "authbroker:";
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;

async function claimBrokerNonce(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  if (!deps.replayDedupe)
    return reply(503, {
      error: "not_configured",
      message:
        "single-use claims need the Postgres-backed replay store; set DATABASE_URL so a restart cannot resurrect a spent sign-in link",
    });
  const b = isObj(body) ? body : {};
  const ids: unknown[] = Array.isArray(b.ids) ? b.ids : [];
  if (ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0))
    return reply(400, { error: "bad_request", message: "ids must hold at least one non-empty string" });
  const now = Date.now();
  const expiresAtMs = b.expiresAtMs;
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs > now + MAX_HORIZON_MS
  )
    return reply(400, {
      error: "bad_request",
      message: "expiresAtMs must be a future epoch-millisecond timestamp within 24 hours",
    });
  for (const id of ids as string[]) {
    if (await deps.replayDedupe.claim(`${NAMESPACE}${id}`, expiresAtMs)) return ok({ claimed: id });
  }
  return ok({ claimed: null });
}

async function emailAllowed(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, app, url } = ctx;
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!validEmail(email)) return reply(400, { error: "bad_request", message: "email required" });
  if (!deps.identity) return ok({ allowed: false });
  await deps.identity.refresh();
  if (deps.identity.deactivationSource(email) === "manual") return ok({ allowed: false });
  const member = deps.identity.externalMember(email);
  const configured =
    deps.emailAuthPrincipals?.includes(email) ||
    Boolean(deps.emailAuthDomain && email.endsWith(`@${deps.emailAuthDomain}`));
  const allowed =
    deps.identity.classify(email).type === "internal" && (member ? externalMemberActive(member) : configured);
  if (allowed) return ok({ allowed: true, expiresAt: member?.expiresAt });
  const grantee = `personal:${email}`;
  const sharedDeployments = ((await deps.acl?.list()) ?? []).flatMap((g) => {
    const ref = parseRef(g.ref);
    return g.granteeScopeId === grantee && g.permission === "read" && ref.kind === "deploy"
      ? [{ id: ref.id, ownerScopeId: g.ownerScopeId }]
      : [];
  });
  for (const shared of sharedDeployments) {
    const d = await app.getDeployment(shared.id);
    if (!d || d.id !== shared.id || d.ownerScopeId !== shared.ownerScopeId || d.status === "archived") continue;
    if (await externalAppSharingAllowed(deps.featureFlags, d.ownerScopeId)) return ok({ allowed: true, appOnly: true });
  }
  return ok({ allowed: false });
}

async function brokerSession(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  if (!deps.brokerSessions) return reply(503, { error: "not_configured" });
  const b = isObj(body) ? body : {};
  if (ctx.pathname.endsWith("/use")) {
    if (typeof b.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(b.token))
      return reply(400, { error: "invalid_token" });
    return ok({ session: await deps.brokerSessions.use(b.token) });
  }
  if (typeof b.email !== "string" || !validEmail(b.email)) return reply(400, { error: "invalid_email" });
  const email = b.email.trim().toLowerCase();
  if (ctx.pathname.endsWith("/revoke")) {
    if (ctx.actor?.p.toLowerCase() !== email && !(await authorizeAdmin(ctx, tenant().orgScope))) return;
    await deps.brokerSessions.revoke(email);
    audit(deps, {
      principalId: ctx.actor?.p ?? "admin",
      action: "auth.broker.revoke",
      resource: email,
      scopeLabel: tenant().orgScope,
    });
    return ok({ ok: true });
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
    return reply(400, { error: "invalid_lifetime" });
  return ok(await deps.brokerSessions.create(email, idleS, absoluteS));
}

async function trustedAdmin(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  const secret = deps.portalIdentitySecret;
  if (!secret || secret.length < 32 || secret === ctx.secret || !deps.admin || !deps.replayDedupe)
    return reply(503, { error: "not_configured" });
  const assertion = isObj(body) && typeof body.assertion === "string" ? body.assertion : "";
  const claims = await verifySignedPayload(assertion, secret);
  const now = Date.now();
  if (
    !isObj(claims) ||
    claims.purpose !== "trusted-entry-admin" ||
    claims.org !== tenant().orgScope ||
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
    return reply(403, { error: "invalid_assertion" });
  const principalId = `oidc:${createHash("sha256").update(claims.issuer).digest("hex")}:${Buffer.from(claims.subject).toString("base64url")}`;
  if (!(await activePrincipal(deps, principalId))) return reply(403, { error: "inactive_principal" });
  if (!(await deps.replayDedupe.claim(`trusted-admin:${claims.jti}`, claims.exp)))
    return reply(409, { error: "assertion_already_used" });
  try {
    const { grant, created } = await deps.admin.provisionTrustedEntry(claims.issuer, claims.subject);
    if (created)
      audit(deps, {
        principalId: grant.grantedBy!,
        action: "grant.create",
        resource: `${grant.principalId}/org_admin`,
        scopeLabel: grant.scopeId,
      });
    return ok({ ok: true });
  } catch (error) {
    if (error instanceof AdminError) return reply(error.status, { error: "grant_failed", message: error.message });
    throw error;
  }
}

async function redeemInvitation(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  if (!deps.portalIdentitySecret || !deps.replayDedupe || !deps.identity || !deps.portalUrl)
    return reply(503, { error: "not_configured" });
  const token = isObj(body) && typeof body.token === "string" ? body.token : "";
  const claims = token.length <= 4096 ? await verifySignedPayload(token, deps.portalIdentitySecret) : null;
  const now = Date.now();
  if (
    !isObj(claims) ||
    claims.purpose !== "teammate-invite" ||
    claims.org !== tenant().orgScope ||
    claims.aud !== deps.portalUrl ||
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
    return reply(400, { error: "invalid_invitation" });
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
    return reply(403, { error: "invitation_revoked" });
  if (!(await deps.replayDedupe.claim(`teammate-invite:${claims.jti}`, claims.exp)))
    return reply(400, { error: "invitation_used" });
  audit(deps, {
    principalId: claims.email,
    action: "user.invite.redeem",
    resource: claims.email,
    scopeLabel: tenant().orgScope,
  });
  return ok({ email: claims.email });
}

export const authBrokerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/invitations/redeem", actor: "system", auth: "source", handle: redeemInvitation },
  { method: "POST", path: "/v1/auth/trusted/admin", actor: "system", auth: "source", handle: trustedAdmin },
  { method: "POST", path: "/v1/auth/broker/sessions", actor: "system", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/sessions/use", actor: "system", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/sessions/revoke", actor: "person", auth: "source", handle: brokerSession },
  { method: "POST", path: "/v1/auth/broker/claim", actor: "system", auth: "source", handle: claimBrokerNonce },
  { method: "GET", path: "/v1/auth/broker/email-allowed", auth: "source", handle: emailAllowed },
];
