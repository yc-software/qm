import { randomUUID } from "node:crypto";
import { mintSignedPayload } from "../../../auth/signed-token.ts";
import { scopeId as makeScopeId } from "../../../types.ts";
import { adminStatusFromGrants, AdminError } from "../../../admin/admin-service.ts";
import { personKey, samePerson } from "../../../directory/person.ts";
import type { AdminRole } from "../../../admin/admin-grant-store.ts";
import type { DirectoryMember } from "../../../directory/directory-store.ts";
import { computeUsers } from "../../../admin/users.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail } from "../../../admin/invite-email.ts";
import { externalMemberActive, validEmail, type ExternalMember } from "../../../identity/external-members.ts";
import { resolveBranding } from "../../../resolution/branding.ts";
import { errMessage } from "../../../util/errors.ts";
import { normalizeInboundExpiresAt } from "../../expiry.ts";
import { isObj } from "../shared.ts";
import { badRequest, notFound, orgAdmin } from "./common.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";

const EXTERNAL_ORG_ADMIN_PORTAL_ONLY =
  "granting or removing org admin for an external user is portal-only — the agent cannot manage who governs the org";
const ALREADY_A_MEMBER =
  "that address already belongs to a member of the org and does not need an external invite. To make them an admin, use Make admin on their row in the admin Users page.";
const HOLDS_OWN_GRANT =
  "that address holds an org admin grant of its own — revoke it under Admins first, or re-invite with role org_admin";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

export async function listUsers(ctx: ApiCtx): Promise<RouteResult> {
  const { deps } = ctx;
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  authz.audit("users.read", "users");
  const participants = (await deps.sessions?.listParticipants()) ?? [];
  const turns = (await deps.sessions?.attributedTurns()) ?? [];
  const grants = (await deps.admin?.listGrants()) ?? [];
  const users = computeUsers({ participants, turns, grants });
  const now = Date.now();
  const externalUsers = ((await deps.identity?.listExternalMembers()) ?? [])
    .map((m) => ({ ...m, status: externalMemberActive(m, now) ? ("active" as const) : ("expired" as const) }))
    .sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
    );
  for (const member of externalUsers.filter((m) => m.kind === "teammate" && m.status === "active")) {
    if (!users.some((u) => samePerson(u.principalId, member.email)))
      users.push({
        principalId: member.email,
        sessionCount: 0,
        turnCount: 0,
        lastSeenAt: null,
        admin: adminStatusFromGrants(grants, member.email),
      });
  }
  const signInUrl = signInUrlOf(deps);
  const inviteEmail = {
    configured: deps.inviteMailer !== undefined,
    ...(deps.inviteMailer ? {} : { problem: INVITE_EMAIL_NOT_CONFIGURED }),
    ...(signInUrl ? { signInUrl } : {}),
  };
  return ok({
    scopeId: scope,
    users,
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
  return deps.portalUrl ? `${deps.portalUrl}/auth/login` : undefined;
}

function endOfDayUtc(value: unknown): unknown {
  return typeof value === "string" && DATE_ONLY.test(value.trim()) ? `${value.trim()}T23:59:59.999Z` : value;
}

function grantError(error: string, e: unknown): RouteResult {
  if (e instanceof AdminError) return reply(e.status, { error, message: e.message });
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

export const inviteExternalUser = (ctx: ApiCtx): Promise<RouteResult> => inviteUser(ctx, false);

export const inviteTeammate = (ctx: ApiCtx): Promise<RouteResult> => inviteUser(ctx, true);

async function inviteUser(ctx: ApiCtx, teammate: boolean): Promise<RouteResult> {
  const { deps, body } = ctx;
  const authz = await orgAdmin(ctx);
  const { actor, scope } = authz;
  if (!deps.identity) throw notFound();
  if (teammate && ctx.capability)
    return reply(403, { error: "forbidden", message: "Teammate invitations must be made in Admin." });
  const bad = (message: string) => badRequest(message);
  const b = isObj(body) ? body : {};
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  if (!validEmail(email)) throw bad("a valid email address is required");
  const role = b.role ?? "member";
  if (role !== "member" && role !== "org_admin") throw bad("role must be member or org_admin");
  const expiry = normalizeInboundExpiresAt(endOfDayUtc(b.expiresAt));
  if (!expiry.ok) throw bad(expiry.message);
  if (teammate && (!deps.portalUrl || !deps.portalIdentitySecret || !deps.replayDedupe))
    return reply(503, {
      error: "not_configured",
      message: "Invitation sign-in requires a portal and durable token storage.",
    });
  const now = Date.now();
  if ((!teammate && expiry.value === undefined) || (expiry.value !== undefined && expiry.value <= now))
    throw bad("expiresAt is required and must be in the future");
  await deps.identity.refresh(true);
  if (teammate && deps.identity.deactivationSource(email) === "manual")
    return reply(409, {
      error: "conflict",
      message: "This account is manually deactivated. Reactivate it before inviting them.",
    });
  const existing = deps.identity.externalMember(email);
  if (!teammate && existing?.kind === "teammate") throw bad("Manage this teammate in Users.");
  const holdsGrant = adminStatusFromGrants(await deps.admin!.listGrants(), email).isAdmin;
  const ownsGrant = existing?.role === "org_admin";
  if (!teammate && ((!existing && holdsGrant) || (await orgMember(ctx, email, !existing))))
    return reply(409, { error: "conflict", message: ALREADY_A_MEMBER });
  if (ctx.capability && (role === "org_admin" || ownsGrant || holdsGrant))
    return reply(403, { error: "forbidden", message: EXTERNAL_ORG_ADMIN_PORTAL_ONLY });
  if (!teammate && role === "member" && holdsGrant && !ownsGrant)
    return reply(409, { error: "conflict", message: HOLDS_OWN_GRANT });
  let grantChange: "grant.create" | "grant.revoke" | null = null;
  if (role === "org_admin" && !holdsGrant) grantChange = "grant.create";
  else if (!teammate && role === "member" && holdsGrant) grantChange = "grant.revoke";
  try {
    if (grantChange === "grant.create")
      await deps.admin!.createGrant(actor, { principalId: email, role: "org_admin", scopeId: scope });
    else if (grantChange === "grant.revoke") await deps.admin!.revokeGrant(actor, email, scope, "org_admin");
  } catch (e) {
    return grantError("grant_failed", e);
  }
  if (grantChange) authz.audit(grantChange, `${email}/org_admin`);
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
  await deps.identity.putExternalMember(member);
  const action = created || readmitted ? "external_user.invite" : "external_user.update";
  authz.audit(teammate ? "user.invite" : action, email);
  const signInUrl = teammate
    ? `${deps.portalUrl!}/auth/invite#token=${encodeURIComponent(
        await mintSignedPayload(
          {
            purpose: "teammate-invite",
            inviteId: member.inviteId,
            email,
            org: scope,
            aud: deps.portalUrl!,
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
  return ok({
    ok: true,
    member,
    created,
    emailSent,
    ...(emailProblem ? { emailProblem } : {}),
    ...(!emailSent && signInUrl ? { signInUrl } : {}),
  });
}

export async function revokeExternalUser(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, params } = ctx;
  const authz = await orgAdmin(ctx);
  const { actor, scope } = authz;
  if (!deps.identity) throw notFound();
  await deps.identity.refresh(true);
  const existing = deps.identity.externalMember(params.email ?? "");
  if (!existing) return reply(404, { error: "not_found", message: "external user not found" });
  const holdsGrant = adminStatusFromGrants(await deps.admin!.listGrants(), existing.email).isAdmin;
  const ownsGrant = existing.role === "org_admin";
  if (ctx.capability && (existing.kind === "teammate" || ownsGrant || holdsGrant))
    return reply(403, { error: "forbidden", message: EXTERNAL_ORG_ADMIN_PORTAL_ONLY });
  if (holdsGrant && !ownsGrant) return reply(409, { error: "conflict", message: HOLDS_OWN_GRANT });
  if (holdsGrant) {
    try {
      await deps.admin!.revokeGrant(actor, existing.email, scope, "org_admin");
    } catch (e) {
      return grantError("revoke_failed", e);
    }
    authz.audit("grant.revoke", `${existing.email}/org_admin`);
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
    authz.audit("external_user.revoke", existing.email);
  }
  if (existing.kind === "teammate" || now - tombstone.expiresAt! < FORGET_AFTER_MS)
    return ok({ ok: true, removed: false });
  await deps.identity.removeExternalMember(existing.email);
  authz.audit("external_user.forget", existing.email);
  return ok({ ok: true, removed: true });
}

export async function searchDirectory(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, app, url } = ctx;
  await orgAdmin(ctx);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q || !deps.directory) return ok({ members: [] });
  const r = await app.resolveRecipient(q);
  let members: DirectoryMember[] = [];
  if (r.kind === "one") members = [r.member];
  else if (r.kind === "ambiguous") members = r.candidates;
  return ok({
    members: members.map((m) => ({ principalId: m.principalId, displayName: m.displayName })),
  });
}

export async function listKeychainStatus(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps } = ctx;
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  authz.audit("keychain.read", "keychain");

  if (!deps.keychain) return ok({ scopeId: scope, people: [], credentials: [], grants: [], asks: [], enabled: false });

  const principalId = ctx.url.searchParams.get("principal")?.trim();
  if (principalId) {
    const [credentials, grants] = await Promise.all([
      deps.keychain.listByOwner(principalId),
      deps.keychain.listGrants({ ownerId: principalId }),
    ]);
    return ok({ scopeId: scope, credentials, grants, enabled: true });
  }

  if (ctx.url.searchParams.get("summary") === "1") {
    const [credentials, grants] = await Promise.all([deps.keychain.listAllMetadata(), deps.keychain.listGrants({})]);
    return ok({
      users: new Set(credentials.map((credential) => credential.ownerId)).size,
      standing: grants.filter(
        (grant) =>
          grant.mode === "standing" && grant.status === "active" && (!grant.expiresAt || grant.expiresAt > Date.now()),
      ).length,
    });
  }

  const [credentials, grants, asks, participantIds, adminGrants] = await Promise.all([
    deps.keychain.listAllMetadata(),
    deps.keychain.listGrants({}),
    deps.keychain.listAsks({}),
    deps.sessions?.distinctParticipants() ?? Promise.resolve([]),
    deps.admin?.listGrants() ?? Promise.resolve([]),
  ]);
  const ids = new Set<string>([
    ...credentials.map((c) => c.ownerId),
    ...grants.map((g) => g.ownerId),
    ...grants.map((g) => g.usedBy).filter((id): id is string => !!id),
    ...asks.map((a) => a.ownerId),
    ...asks.map((a) => a.requesterId),
    ...participantIds,
    ...adminGrants.map((g) => g.principalId),
  ]);

  const members = await app.directoryMembers();
  const namesByKey = new Map(members.map((m) => [personKey(m.principalId), m.displayName]));
  const rosterIdByKey = new Map(members.map((m) => [personKey(m.principalId), m.principalId]));
  const idByKey = new Map<string, string>();
  for (const id of ids) {
    const key = personKey(id);
    if (!idByKey.has(key)) idByKey.set(key, rosterIdByKey.get(key) ?? id);
  }
  const people = [...idByKey.values()].sort().map((principalId) => ({
    principalId,
    displayName: namesByKey.get(personKey(principalId)) ?? null,
    credentialCount: credentials.filter((c) => samePerson(c.ownerId, principalId)).length,
    activeGrantCount: grants.filter(
      (g) =>
        samePerson(g.ownerId, principalId) &&
        g.status === "active" &&
        (g.expiresAt === undefined || g.expiresAt > Date.now()),
    ).length,
    pendingAskCount: asks.filter((a) => samePerson(a.ownerId, principalId) && a.status === "pending").length,
  }));

  return ok({ scopeId: scope, people, credentials, grants, asks, enabled: true });
}

async function resolveAdminUser(deps: ApiCtx["deps"], requestedPrincipal: string) {
  const member = await deps.directory?.get(requestedPrincipal);
  return { member, principalId: member?.principalId ?? personKey(requestedPrincipal) };
}

export async function getUserDetail(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, params } = ctx;
  const authz = await orgAdmin(ctx);
  const { member, principalId } = await resolveAdminUser(deps, params.principalId!);
  const personal = makeScopeId("personal", principalId);
  authz.audit("user.read", principalId);

  const [grants, stats] = await Promise.all([
    deps.admin?.listGrants() ?? [],
    deps.sessions?.scopeConversationCount(personal),
  ]);
  const config = deps.config
    ? {
        hasInstructions: !!deps.config.getInstructions(personal),
        instructionsVersion: deps.config.instructionsVersion(personal),
        commandPolicy: deps.config.setting("commandPolicy", personal),
        egress: deps.config.setting("egress", personal),
        baseModel: deps.config.getRuntimeSelection(personal)?.modelId ?? null,
        connectors: await deps.config.listConnectorClients(personal),
      }
    : null;

  return ok({
    principalId,
    scopeId: personal,
    ...(member?.displayName ? { displayName: member.displayName } : {}),
    admin: adminStatusFromGrants(grants, principalId),
    stats: { sessions: stats ?? 0 },
    config,
  });
}

export async function startImpersonation(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body } = ctx;
  const authz = await orgAdmin(ctx);
  const target = String((body as { target?: string } | undefined)?.target ?? "").trim();
  if (!target) throw badRequest("target principal required");
  if (target === authz.actor.id) throw badRequest("cannot impersonate yourself");
  const member = await app.directoryMember(target);
  authz.audit("impersonate.start", target);
  return ok({ ok: true, target, displayName: member?.displayName ?? target });
}

export async function stopImpersonation(ctx: ApiCtx): Promise<RouteResult> {
  const { body } = ctx;
  const authz = await orgAdmin(ctx);
  const target = String((body as { target?: string } | undefined)?.target ?? "").trim();
  authz.audit("impersonate.stop", target || "-");
  return ok({ ok: true });
}

export async function resetUserToBrandNew(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, params } = ctx;
  const authz = await orgAdmin(ctx);
  const { principalId } = await resolveAdminUser(deps, params.principalId!);
  const personal = makeScopeId("personal", principalId);
  const sessions = deps.sessions;
  const own = sessions ? (await sessions.listByParticipant(principalId)).filter((s) => s.scopeId === personal) : [];
  for (const s of own) await sessions!.deleteSession(s.id);
  const deletedSessions = own.length;
  authz.audit("user.reset", `${principalId}/sessions=${deletedSessions}`, personal);
  return ok({ ok: true, scopeId: personal, deletedSessions });
}

export async function createAdminGrant(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body } = ctx;
  const authz = await orgAdmin(ctx);
  const { actor } = authz;
  const b = body as { principalId?: string; role?: string; scopeId?: string };
  try {
    const grant = await deps.admin!.createGrant(actor, {
      principalId: String(b.principalId ?? ""),
      role: b.role as AdminRole,
      scopeId: String(b.scopeId ?? ""),
    });
    authz.audit("grant.create", `${grant.principalId}/${grant.role}`, grant.scopeId);
    return ok({ ok: true, grant });
  } catch (e) {
    return grantError("grant_failed", e);
  }
}

export async function revokeAdminGrant(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, url, params } = ctx;
  const authz = await orgAdmin(ctx);
  const { actor } = authz;
  const principalId = params.principalId!;
  const scope = url.searchParams.get("scope") ?? "";
  const role = url.searchParams.get("role") ?? "";
  if (!principalId || !scope || role !== "org_admin")
    throw badRequest("principalId (path), and scope + role=org_admin (query) required");
  try {
    await deps.admin!.revokeGrant(actor, principalId, scope, role);
    authz.audit("grant.revoke", `${principalId}/${role}`, scope);
    return ok({ ok: true });
  } catch (e) {
    return grantError("revoke_failed", e);
  }
}
