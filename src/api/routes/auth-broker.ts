import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { createHash } from "node:crypto";
import { verifySignedPayload } from "../../auth/signed-token.ts";
import { AdminError } from "../../admin/admin-service.ts";
import { sendJson } from "../http.ts";
import { deployRef, encodeRef } from "../../acl/resource-ref.ts";
import { externalMemberActive, validEmail } from "../../identity/external-members.ts";
import { isObj, authorizeAdmin, orgScope, audit, activePrincipal } from "./shared.ts";
import { tenantOf, type ApiCtx, type Route } from "./route.ts";
import { inTenant } from "../../tenants/claim.ts";
import { tenantAllowsEmail } from "../../tenants/settings.ts";
import { bootTenant } from "../../tenants/boot.ts";
import { labelOfAppHost, splitAppLabel } from "../../tenants/app-handle.ts";
import { trimTrailingSlashes } from "../../util/text.ts";

const NAMESPACE = "authbroker:";
const MAX_IDS = 64;
const MAX_ID_LENGTH = 200;
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;

async function claimBrokerNonce(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.replayDedupe) {
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

function multitenant(): boolean {
  return !bootTenant();
}

async function rosterAdmits(ctx: ApiCtx, email: string, listed: boolean): Promise<boolean> {
  const { deps } = ctx;
  const tenant = ctx.tenant?.id;
  if (tenant && multitenant()) {
    if (listed || (await tenantAllowsEmail(email)) === true) return true;
    return Boolean((await deps.directory?.tenantsForEmail?.(email))?.some(({ id }) => id === tenant));
  }
  return (
    (tenant ? await tenantAllowsEmail(email) : undefined) ??
    (listed ||
      deps.emailAuthPrincipals?.includes(email) ||
      Boolean(deps.emailAuthDomain && email.endsWith(`@${deps.emailAuthDomain}`)))
  );
}

type Admission = { allowed: boolean; appOnly?: true; expiresAt?: number | null };

async function admission(ctx: ApiCtx, email: string, listed = false): Promise<Admission> {
  const { deps, app } = ctx;
  if (!deps.identity) return { allowed: false };
  await deps.identity.refresh();
  if (deps.identity.deactivationSource(email) === "manual") return { allowed: false };
  const member = deps.identity.externalMember(email);
  const configured = await rosterAdmits(ctx, email, listed);
  const allowed =
    deps.identity.classify(email).type === "internal" && (member ? externalMemberActive(member) : configured);
  if (allowed) return { allowed: true, expiresAt: member?.expiresAt };
  const grants =
    (await deps.acl?.find(tenantOf(ctx), { granteeScopeIds: [`personal:${email}`], kind: "deploy" })) ?? [];
  const publishedApps = await app.listApps();
  const granted = publishedApps.filter(
    (d) =>
      d.status !== "archived" &&
      grants.some(
        (g) => g.ownerScopeId === d.ownerScopeId && g.ref === encodeRef(deployRef(d.id)) && g.permission === "read",
      ),
  );
  const allowedOwners = await Promise.all(
    granted.map((d) => externalAppSharingAllowed(deps.featureFlags, d.ownerScopeId)),
  );
  return allowedOwners.some(Boolean) ? { allowed: true, appOnly: true } : { allowed: false };
}

function requestedEmail(ctx: ApiCtx): string | null {
  const email = (ctx.url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (validEmail(email)) return email;
  sendJson(ctx.res, 400, { error: "bad_request", message: "email required" });
  return null;
}

async function emailAllowed(ctx: ApiCtx): Promise<void> {
  const email = requestedEmail(ctx);
  if (!email) return;
  const tenants = ctx.deps.directory?.tenantsForEmail;
  if (ctx.tenant || !tenants) return sendJson(ctx.res, 200, await admission(ctx, email));
  for (const { id } of await tenants(email)) {
    const admitted = await inTenant(id, (tenant) => admission({ ...ctx, tenant }, email, true));
    if (admitted.allowed) return sendJson(ctx.res, 200, admitted);
  }
  return sendJson(ctx.res, 200, { allowed: false });
}

async function emailTenants(ctx: ApiCtx): Promise<void> {
  const email = requestedEmail(ctx);
  if (!email) return;
  const tenants = ctx.deps.directory?.tenantsForEmail;
  return sendJson(ctx.res, 200, {
    tenants: tenants ? await tenants(email) : [],
    shared: multitenant(),
  });
}

async function principalTenants(ctx: ApiCtx): Promise<void> {
  const principal = (ctx.url.searchParams.get("principal") ?? "").trim();
  if (!principal) return sendJson(ctx.res, 400, { error: "bad_request", message: "principal required" });
  const tenants = ctx.deps.directory?.tenantsForPrincipal;
  return sendJson(ctx.res, 200, {
    tenants: tenants ? await tenants(principal) : [],
    shared: multitenant(),
  });
}

async function appHostTenant(ctx: ApiCtx, host: string): Promise<string | undefined> {
  const label = labelOfAppHost(host, ctx.deps.deployAppsDomain);
  const split = label === undefined ? undefined : splitAppLabel(label);
  return split && ctx.deps.directory?.tenantForAppHandle?.(split.handle);
}

async function hostTenant(ctx: ApiCtx): Promise<void> {
  const host = (ctx.url.searchParams.get("host") ?? "").trim().toLowerCase();
  if (!host || host.length > 253) return sendJson(ctx.res, 400, { error: "bad_request", message: "host required" });
  const app = await appHostTenant(ctx, host);
  return sendJson(ctx.res, 200, app ? { tenant: app, app: true } : { tenant: null });
}

async function workspaceTenant(ctx: ApiCtx): Promise<void> {
  const handle = (ctx.url.searchParams.get("handle") ?? "").trim().toLowerCase();
  if (!handle || handle.length > 63)
    return sendJson(ctx.res, 400, { error: "bad_request", message: "handle required" });
  const tenant = await ctx.deps.directory?.tenantForAppHandle?.(handle);
  if (!tenant) return sendJson(ctx.res, 200, { tenant: null });
  const client = await ctx.deps.directory?.trustedClientFor?.(tenant);
  return sendJson(ctx.res, 200, { tenant, ...(client ? { trustedClient: client } : {}) });
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
    audit(ctx, {
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
  const { deps, res, body, tenant } = ctx;
  if (!tenant) {
    res.writeHead(204);
    return void res.end();
  }
  const secret = deps.portalIdentitySecret;
  if (!secret || secret.length < 32 || secret === ctx.secret || !deps.admin || !deps.replayDedupe)
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
    const { grant, created } = await deps.admin.provisionTrustedEntry(tenant, claims.issuer, claims.subject);
    if (created)
      audit(ctx, {
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
  if (!deps.portalIdentitySecret || !deps.replayDedupe || !deps.identity || !deps.portalUrl)
    return sendJson(res, 503, { error: "not_configured" });
  const token = isObj(body) && typeof body.token === "string" ? body.token : "";
  const claims = token.length <= 4096 ? await verifySignedPayload(token, deps.portalIdentitySecret) : null;
  const now = Date.now();
  if (
    !isObj(claims) ||
    claims.purpose !== "teammate-invite" ||
    claims.org !== orgScope(deps) ||
    claims.aud !== trimTrailingSlashes(deps.portalUrl) ||
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
  audit(ctx, {
    principalId: claims.email,
    action: "user.invite.redeem",
    resource: claims.email,
    scopeLabel: orgScope(deps),
  });
  return sendJson(res, 200, { email: claims.email });
}

export const authBrokerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/invitations/redeem", actor: "system", auth: "source", handle: redeemInvitation },
  {
    method: "POST",
    path: "/v1/auth/trusted/admin",
    actor: "system",
    auth: "source",
    tenant: "optional",
    handle: trustedAdmin,
  },
  {
    method: "POST",
    path: "/v1/auth/broker/sessions",
    actor: "system",
    auth: "source",
    tenant: "optional",
    handle: brokerSession,
  },
  {
    method: "POST",
    path: "/v1/auth/broker/sessions/use",
    actor: "system",
    auth: "source",
    tenant: "optional",
    handle: brokerSession,
  },
  {
    method: "POST",
    path: "/v1/auth/broker/sessions/revoke",
    actor: "person",
    auth: "source",
    tenant: "optional",
    handle: brokerSession,
  },
  {
    method: "POST",
    path: "/v1/auth/broker/claim",
    actor: "system",
    auth: "source",
    tenant: "optional",
    handle: claimBrokerNonce,
  },
  { method: "GET", path: "/v1/auth/broker/email-allowed", auth: "source", tenant: "optional", handle: emailAllowed },
  { method: "GET", path: "/v1/auth/broker/email-tenants", auth: "source", tenant: "none", handle: emailTenants },
  {
    method: "GET",
    path: "/v1/auth/broker/principal-tenants",
    auth: "source",
    tenant: "none",
    handle: principalTenants,
  },
  { method: "GET", path: "/v1/auth/broker/host-tenant", auth: "source", tenant: "none", handle: hostTenant },
  { method: "GET", path: "/v1/auth/broker/workspace", auth: "source", tenant: "none", handle: workspaceTenant },
];
