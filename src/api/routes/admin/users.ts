import { randomUUID } from "node:crypto";
import { gatewayActorId } from "../../../model/provider-endpoints.ts";
import { mintSignedPayload } from "../../../auth/signed-token.ts";
import { scopeId as makeScopeId } from "../../../types.ts";
import { adminStatusFromGrants, AdminError } from "../../../admin/admin-service.ts";
import { foldPrincipalId, personKey, samePerson } from "../../../directory/person.ts";
import type { AdminRole } from "../../../admin/admin-grant-store.ts";
import type { DirectoryMember } from "../../../directory/directory-store.ts";
import { computeUsers } from "../../../admin/users.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail } from "../../../admin/invite-email.ts";
import { externalMemberActive, validEmail, type ExternalMember } from "../../../identity/external-members.ts";
import { resolveBranding } from "../../../resolution/branding.ts";
import { errMessage } from "../../../util/errors.ts";
import { normalizeInboundExpiresAt } from "../../expiry.ts";
import { detectOnboardingStatus, setOnboardingStatus, type OnboardingStatus } from "../../../onboarding/onboarding.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, isObj, orgScope } from "../shared.ts";
import { tenantOf, type ApiCtx } from "../route.ts";
import { personNamer } from "./common.ts";
import { trimTrailingSlashes } from "../../../util/text.ts";

const EXTERNAL_ORG_ADMIN_PORTAL_ONLY =
  "granting or removing org admin for an external user is portal-only — the agent cannot manage who governs the org";
const ALREADY_A_MEMBER =
  "that address already belongs to a member of the org and does not need an external invite. To make them an admin, use Make admin on their row in the admin Users page.";
const HOLDS_OWN_GRANT =
  "that address holds an org admin grant of its own — revoke it under Admins first, or re-invite with role org_admin";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

export async function listUsers(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(ctx, { principalId: actor.id, action: "users.read", resource: "users", scopeLabel: scope });
  const [roster, activity, grants] = await Promise.all([
    deps.admin!.users.list(),
    deps.admin!.users.activity(),
    deps.admin?.listGrants(tenantOf(ctx)) ?? [],
  ]);
  const now = Date.now();
  const externalUsers = ((await deps.identity?.listExternalMembers()) ?? [])
    .map((m) => ({ ...m, status: externalMemberActive(m, now) ? ("active" as const) : ("expired" as const) }))
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
    );
  const rows = computeUsers({ roster, activity, grants }).map((u) => ({
    ...u,
    deactivated: deps.identity?.deactivationSource(u.principalId) !== undefined,
  }));
  const signInUrl = signInUrlOf(deps);
  const inviteEmail = {
    configured: deps.inviteMailer !== undefined,
    ...(deps.inviteMailer ? {} : { problem: INVITE_EMAIL_NOT_CONFIGURED }),
    ...(signInUrl ? { signInUrl } : {}),
  };
  const actorKey = deps.modelGatewayTransport?.actorKey;
  const nameOf = await personNamer(ctx.app, deps);
  return sendJson(res, 200, {
    scopeId: scope,
    users: rows.map((user) => {
      const displayName = nameOf(user.principalId);
      return {
        ...user,
        ...(displayName && displayName !== user.principalId ? { displayName } : {}),
        ...(actorKey ? { gatewayActor: gatewayActorId(user.principalId, actorKey) } : {}),
      };
    }),
    grants,
    externalUsers,
    inviteEmail,
    access: {
      emailDomain: deps.emailAuthDomain ?? null,
      slackAllowFrom: deps.slackAllowFrom ?? null,
    },
  });
}

function signInUrlOf(deps: ApiCtx["deps"]): string | undefined {
  return deps.portalUrl ? `${trimTrailingSlashes(deps.portalUrl)}/auth/login` : undefined;
}

function endOfDayUtc(value: unknown): unknown {
  return typeof value === "string" && DATE_ONLY.test(value.trim()) ? `${value.trim()}T23:59:59.999Z` : value;
}

function grantError(res: ApiCtx["res"], error: string, e: unknown): void {
  if (e instanceof AdminError) return sendJson(res, e.status, { error, message: e.message });
  throw e;
}

async function orgMember(ctx: ApiCtx, email: string, includeSessions: boolean): Promise<boolean> {
  const { deps } = ctx;
  if (deps.emailAuthDomain && email.endsWith(`@${deps.emailAuthDomain}`)) return true;
  if ((deps.emailAuthPrincipals ?? []).some((principal) => samePerson(principal, email))) return true;
  if (await deps.directory?.get(email)) return true;
  if (!includeSessions) return false;
  const participants = (await deps.sessions?.listParticipants()) ?? [];
  return participants.some((participant) => samePerson(participant.principalId, email));
}

export async function inviteExternalUser(ctx: ApiCtx): Promise<void> {
  return inviteUser(ctx, false);
}

export async function inviteTeammate(ctx: ApiCtx): Promise<void> {
  return inviteUser(ctx, true);
}

async function inviteUser(ctx: ApiCtx, teammate: boolean): Promise<void> {
  const { res, deps, body } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  if (teammate && ctx.capability)
    return sendJson(res, 403, { error: "forbidden", message: "Teammate invitations must be made in Admin." });
  const bad = (message: string) => sendJson(res, 400, { error: "bad_request", message });
  const b = isObj(body) ? body : {};
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  if (!validEmail(email)) return bad("a valid email address is required");
  const role = b.role ?? "member";
  if (role !== "member" && role !== "org_admin") return bad("role must be member or org_admin");
  const expiry = normalizeInboundExpiresAt(endOfDayUtc(b.expiresAt));
  if (!expiry.ok) return bad(expiry.message);
  if (teammate && (!deps.portalUrl || !deps.portalIdentitySecret || !deps.replayDedupe))
    return sendJson(res, 503, {
      error: "not_configured",
      message: "Invitation sign-in requires a portal and durable token storage.",
    });
  const now = Date.now();
  if ((!teammate && expiry.value === undefined) || (expiry.value !== undefined && expiry.value <= now))
    return bad("expiresAt is required and must be in the future");
  await deps.identity.refresh(true);
  if (teammate && deps.identity.deactivationSource(email) === "manual")
    return sendJson(res, 409, {
      error: "conflict",
      message: "This account is manually deactivated. Reactivate it before inviting them.",
    });
  const existing = deps.identity.externalMember(email);
  if (!teammate && existing?.kind === "teammate") return bad("Manage this teammate in Users.");
  const holdsGrant = adminStatusFromGrants(await deps.admin!.listGrants(tenantOf(ctx)), email).isAdmin;
  const ownsGrant = existing?.role === "org_admin";
  if (!teammate && ((!existing && holdsGrant) || (await orgMember(ctx, email, !existing))))
    return sendJson(res, 409, { error: "conflict", message: ALREADY_A_MEMBER });
  if (ctx.capability && (role === "org_admin" || ownsGrant || holdsGrant)) {
    return sendJson(res, 403, { error: "forbidden", message: EXTERNAL_ORG_ADMIN_PORTAL_ONLY });
  }
  if (!teammate && role === "member" && holdsGrant && !ownsGrant)
    return sendJson(res, 409, { error: "conflict", message: HOLDS_OWN_GRANT });
  let grantChange: "grant.create" | "grant.revoke" | null = null;
  if (role === "org_admin" && !holdsGrant) grantChange = "grant.create";
  else if (!teammate && role === "member" && holdsGrant) grantChange = "grant.revoke";
  try {
    if (grantChange === "grant.create")
      await deps.admin!.createGrant(tenantOf(ctx), actor, { principalId: email, role: "org_admin", scopeId: scope });
    else if (grantChange === "grant.revoke")
      await deps.admin!.revokeGrant(tenantOf(ctx), actor, email, scope, "org_admin");
  } catch (e) {
    return grantError(res, "grant_failed", e);
  }
  if (grantChange)
    audit(ctx, { principalId: actor.id, action: grantChange, resource: `${email}/org_admin`, scopeLabel: scope });
  const created = existing === undefined;
  const readmitted = existing !== undefined && !externalMemberActive(existing, now);
  const member: ExternalMember = {
    email,
    role: teammate && holdsGrant ? "org_admin" : role,
    expiresAt: expiry.value ?? null,
    ...(teammate ? { kind: "teammate" as const, inviteId: randomUUID() } : {}),
    invitedBy: existing?.invitedBy ?? actor.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (member.kind === "teammate") await deps.admin!.users.record({ id: email, source: "invite", at: member.createdAt });
  await deps.identity.putExternalMember(member);
  const action = created || readmitted ? "external_user.invite" : "external_user.update";
  audit(ctx, {
    principalId: actor.id,
    action: teammate ? "user.invite" : action,
    resource: email,
    scopeLabel: scope,
  });
  const signInUrl = teammate
    ? `${trimTrailingSlashes(deps.portalUrl!)}/auth/invite#token=${encodeURIComponent(
        await mintSignedPayload(
          {
            purpose: "teammate-invite",
            inviteId: member.inviteId,
            email,
            org: scope,
            aud: trimTrailingSlashes(deps.portalUrl!),
            iat: now,
            exp: now + 24 * 60 * 60 * 1000,
            jti: randomUUID(),
          },
          deps.portalIdentitySecret!,
        ),
      )}`
    : signInUrlOf(deps);
  let emailSent = false;
  let emailProblem: string | undefined;
  if (teammate || created || readmitted || b.resendInvite === true) {
    if (!deps.inviteMailer) emailProblem = INVITE_EMAIL_NOT_CONFIGURED;
    else if (!signInUrl)
      emailProblem = "no sign-in URL is configured on core (set PUBLIC_WEB_URL) — share the portal address by hand";
    else {
      const branding = await resolveBranding(deps.config, scope, deps.brandingDefault);
      try {
        await deps.inviteMailer.send({
          to: email,
          ...renderInviteEmail({
            to: email,
            brandName: branding.selfLabel ?? "qm",
            invitedBy: actor.id,
            signInUrl,
            expiresAt: member.expiresAt,
            magicLink: teammate,
          }),
        });
        emailSent = true;
      } catch (e) {
        emailProblem = errMessage(e);
      }
    }
  }
  return sendJson(res, 200, {
    ok: true,
    member,
    created,
    emailSent,
    ...(emailProblem ? { emailProblem } : {}),
    ...(!emailSent && signInUrl ? { signInUrl } : {}),
  });
}

export async function revokeExternalUser(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
  await deps.identity.refresh(true);
  const existing = deps.identity.externalMember(params.email ?? "");
  if (!existing) return sendJson(res, 404, { error: "not_found", message: "external user not found" });
  const holdsGrant = adminStatusFromGrants(await deps.admin!.listGrants(tenantOf(ctx)), existing.email).isAdmin;
  const ownsGrant = existing.role === "org_admin";
  if (ctx.capability && (existing.kind === "teammate" || ownsGrant || holdsGrant)) {
    return sendJson(res, 403, { error: "forbidden", message: EXTERNAL_ORG_ADMIN_PORTAL_ONLY });
  }
  if (holdsGrant && !ownsGrant) return sendJson(res, 409, { error: "conflict", message: HOLDS_OWN_GRANT });
  if (holdsGrant) {
    try {
      await deps.admin!.revokeGrant(tenantOf(ctx), actor, existing.email, scope, "org_admin");
    } catch (e) {
      return grantError(res, "revoke_failed", e);
    }
    audit(ctx, {
      principalId: actor.id,
      action: "grant.revoke",
      resource: `${existing.email}/org_admin`,
      scopeLabel: scope,
    });
  }
  const now = Date.now();
  const tombstone: ExternalMember = {
    ...existing,
    role: "member",
    expiresAt: Math.min(existing.expiresAt ?? now, now),
    updatedAt: now,
  };
  if (externalMemberActive(existing, now) || existing.role !== "member") {
    await deps.identity.putExternalMember(tombstone);
    audit(ctx, { principalId: actor.id, action: "external_user.revoke", resource: existing.email, scopeLabel: scope });
  }
  if (existing.kind === "teammate" || now - tombstone.expiresAt! < FORGET_AFTER_MS)
    return sendJson(res, 200, { ok: true, removed: false });
  await deps.identity.removeExternalMember(existing.email);
  audit(ctx, { principalId: actor.id, action: "external_user.forget", resource: existing.email, scopeLabel: scope });
  return sendJson(res, 200, { ok: true, removed: true });
}

export async function searchDirectory(ctx: ApiCtx): Promise<void> {
  const { res, deps, app, url } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q || !deps.directory) return sendJson(res, 200, { members: [] });
  const r = await app.resolveRecipient(q);
  let members: DirectoryMember[] = [];
  if (r.kind === "one") members = [r.member];
  else if (r.kind === "ambiguous") members = r.candidates;
  return sendJson(res, 200, {
    members: members.map((m) => ({ principalId: m.principalId, displayName: m.displayName })),
  });
}

export async function listKeychainStatus(ctx: ApiCtx): Promise<void> {
  const { res, app, deps } = ctx;
  const scope = orgScope(deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  audit(ctx, { principalId: actor.id, action: "keychain.read", resource: "keychain", scopeLabel: scope });

  if (!deps.keychain)
    return sendJson(res, 200, { scopeId: scope, people: [], credentials: [], grants: [], asks: [], enabled: false });

  const requested = ctx.url.searchParams.get("principal")?.trim();
  if (requested) {
    const { principalId } = await resolveAdminUser(deps, requested);
    const [credentials, grants] = await Promise.all([
      deps.keychain.listByOwner(principalId),
      deps.keychain.listGrants({ ownerId: principalId }),
    ]);
    return sendJson(res, 200, { scopeId: scope, credentials, grants, enabled: true });
  }

  if (ctx.url.searchParams.get("summary") === "1") {
    const [credentials, grants] = await Promise.all([deps.keychain.listAllMetadata(), deps.keychain.listGrants({})]);
    return sendJson(res, 200, {
      users: new Set(credentials.map((credential) => credential.ownerId)).size,
      standing: grants.filter(
        (grant) =>
          grant.mode === "standing" && grant.status === "active" && (!grant.expiresAt || grant.expiresAt > Date.now()),
      ).length,
    });
  }

  const [credentials, grants, asks, roster, adminGrants] = await Promise.all([
    deps.keychain.listAllMetadata(),
    deps.keychain.listGrants({}),
    deps.keychain.listAsks({}),
    deps.admin!.users.list(),
    deps.admin?.listGrants(tenantOf(ctx)) ?? Promise.resolve([]),
  ]);
  const ids = [
    ...roster.map((u) => u.principalId),
    ...credentials.map((c) => c.ownerId),
    ...grants.map((g) => g.ownerId),
    ...grants.map((g) => g.usedBy).filter((id): id is string => !!id),
    ...asks.map((a) => a.ownerId),
    ...asks.map((a) => a.requesterId),
    ...adminGrants.map((g) => g.principalId),
  ];
  const members = await app.directoryMembers();
  const users = await deps.admin!.users.resolve([...ids, ...members.map((m) => m.principalId)]);
  const keyOf = (id: string) => users.get(id)?.id ?? foldPrincipalId(id);
  const byKey = new Map<string, { userId: string | null; principalId: string }>();
  for (const id of ids) {
    const key = keyOf(id);
    if (!key || byKey.has(key)) continue;
    const user = users.get(id);
    byKey.set(key, { userId: user?.id ?? null, principalId: user?.principalId ?? foldPrincipalId(id) });
  }
  const nameOf = new Map<string, DirectoryMember>();
  for (const m of members) {
    const key = keyOf(m.principalId);
    if (!nameOf.has(key) || foldPrincipalId(m.principalId) === users.get(m.principalId)?.principalId)
      nameOf.set(key, m);
  }
  const now = Date.now();
  const people = [...byKey]
    .map(([key, { userId, principalId }]) => {
      const member = nameOf.get(key);
      return {
        userId,
        principalId: member && foldPrincipalId(member.principalId) === principalId ? member.principalId : principalId,
        displayName: member?.displayName ?? null,
        credentialCount: credentials.filter((c) => keyOf(c.ownerId) === key).length,
        activeGrantCount: grants.filter(
          (g) => keyOf(g.ownerId) === key && g.status === "active" && (g.expiresAt === undefined || g.expiresAt > now),
        ).length,
        pendingAskCount: asks.filter((a) => keyOf(a.ownerId) === key && a.status === "pending").length,
      };
    })
    .sort((a, b) => Number(a.principalId > b.principalId) - Number(a.principalId < b.principalId));

  return sendJson(res, 200, { scopeId: scope, people, credentials, grants, asks, enabled: true });
}

export async function resolveAdminUser(deps: ApiCtx["deps"], requested: string) {
  const user = (await deps.admin?.users.get(requested)) ?? null;
  const member = await deps.directory?.get(user?.principalId ?? requested);
  return { member, user, principalId: member?.principalId ?? user?.principalId ?? personKey(requested) };
}

export async function getUserDetail(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const org = orgScope(deps);
  const actor = await authorizeAdmin(ctx, org);
  if (!actor) return;
  const { member, user, principalId } = await resolveAdminUser(deps, params.principalId!);
  const personal = makeScopeId("personal", principalId);
  audit(ctx, { principalId: actor.id, action: "user.read", resource: principalId, scopeLabel: org });

  const [grants, stats, onboarding] = await Promise.all([
    deps.admin?.listGrants(tenantOf(ctx)) ?? [],
    deps.sessions?.scopeConversationCount(personal),
    deps.memory ? deps.memory.read(personal).then(detectOnboardingStatus) : null,
  ]);
  const config = deps.config
    ? {
        hasSoul: !!deps.config.getSoul(personal),
        soulVersion: deps.config.soulVersion(personal),
        securityPosture: await deps.config.getSecurityPostureDurable(personal),
        commandPolicy: deps.config.getCommandPolicy(personal),
        egress: deps.config.getEgress(personal),
        baseModel: deps.config.getBaseModel(personal),
        connectors: await deps.config.listConnectorClients(personal),
      }
    : null;

  return sendJson(res, 200, {
    userId: user?.id ?? null,
    principalId,
    scopeId: personal,
    ...(member?.displayName ? { displayName: member.displayName } : {}),
    admin: adminStatusFromGrants(grants, principalId),
    deactivated: deps.identity?.deactivationSource(principalId) !== undefined,
    user,
    stats: { sessions: stats ?? 0 },
    config,
    onboarding,
  });
}

export async function startImpersonation(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, body } = ctx;
  const org = orgScope(deps);
  const actor = await authorizeAdmin(ctx, org);
  if (!actor) return;
  const target = String((body as { target?: string } | undefined)?.target ?? "").trim();
  if (!target) return sendJson(res, 400, { error: "bad_request", message: "target principal required" });
  if (target === actor.id) return sendJson(res, 400, { error: "bad_request", message: "cannot impersonate yourself" });
  const member = await app.directoryMember(target);
  audit(ctx, { principalId: actor.id, action: "impersonate.start", resource: target, scopeLabel: org });
  return sendJson(res, 200, { ok: true, target, displayName: member?.displayName ?? target });
}

export async function stopImpersonation(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const org = orgScope(deps);
  const actor = await authorizeAdmin(ctx, org);
  if (!actor) return;
  const target = String((body as { target?: string } | undefined)?.target ?? "").trim();
  audit(ctx, { principalId: actor.id, action: "impersonate.stop", resource: target || "-", scopeLabel: org });
  return sendJson(res, 200, { ok: true });
}

const ONBOARDING_STATUSES = new Set<OnboardingStatus>(["not_started", "pending", "completed", "dismissed"]);

export async function setUserOnboarding(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const { principalId } = await resolveAdminUser(deps, params.principalId!);
  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string" || !ONBOARDING_STATUSES.has(status as OnboardingStatus)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "onboarding requires { status: not_started|pending|completed|dismissed }",
    });
  }
  const personal = makeScopeId("personal", principalId);
  const today = new Date().toISOString().slice(0, 10);
  await setOnboardingStatus(deps.memory, personal, status as OnboardingStatus, today, {
    actorId: actor.id,
    context: "admin",
  });
  audit(ctx, {
    principalId: actor.id,
    action: "user.onboarding.set",
    resource: `${principalId}/${status}`,
    scopeLabel: personal,
  });
  return sendJson(res, 200, { ok: true, scopeId: personal, status });
}

export async function resetUserToBrandNew(ctx: ApiCtx): Promise<void> {
  const { res, deps, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  if (!deps.memory) return sendJson(res, 404, { error: "not_found" });
  const { principalId } = await resolveAdminUser(deps, params.principalId!);
  const personal = makeScopeId("personal", principalId);
  const today = new Date().toISOString().slice(0, 10);
  await setOnboardingStatus(deps.memory, personal, "not_started", today, { actorId: actor.id, context: "admin" });
  let deletedSessions = 0;
  if (deps.sessions) {
    const own = (await deps.sessions.listByParticipant(principalId)).filter((s) => s.scopeId === personal);
    for (const s of own) {
      await deps.sessions.deleteSession(s.id);
      deletedSessions++;
    }
  }
  audit(ctx, {
    principalId: actor.id,
    action: "user.reset",
    resource: `${principalId}/sessions=${deletedSessions}`,
    scopeLabel: personal,
  });
  return sendJson(res, 200, { ok: true, scopeId: personal, deletedSessions });
}

export async function createAdminGrant(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const b = body as { principalId?: string; role?: string; scopeId?: string };
  try {
    const grant = await deps.admin!.createGrant(tenantOf(ctx), actor, {
      principalId: String(b.principalId ?? ""),
      role: b.role as AdminRole,
      scopeId: String(b.scopeId ?? ""),
    });
    audit(ctx, {
      principalId: actor.id,
      action: "grant.create",
      resource: `${grant.principalId}/${grant.role}`,
      scopeLabel: grant.scopeId,
    });
    return sendJson(res, 200, { ok: true, grant });
  } catch (e) {
    if (e instanceof AdminError) return sendJson(res, e.status, { error: "grant_failed", message: e.message });
    throw e;
  }
}

export async function revokeAdminGrant(ctx: ApiCtx): Promise<void> {
  const { res, deps, url, params } = ctx;
  const actor = await authorizeAdmin(ctx, orgScope(deps));
  if (!actor) return;
  const principalId = params.principalId!;
  const scope = url.searchParams.get("scope") ?? "";
  const role = url.searchParams.get("role") ?? "";
  if (!principalId || !scope || role !== "org_admin") {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "principalId (path), and scope + role=org_admin (query) required",
    });
  }
  try {
    await deps.admin!.revokeGrant(tenantOf(ctx), actor, principalId, scope, role);
    audit(ctx, {
      principalId: actor.id,
      action: "grant.revoke",
      resource: `${principalId}/${role}`,
      scopeLabel: scope,
    });
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    if (e instanceof AdminError) return sendJson(res, e.status, { error: "revoke_failed", message: e.message });
    throw e;
  }
}
