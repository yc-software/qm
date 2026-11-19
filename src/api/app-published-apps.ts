import { inheritContextSources, refreshPrivateContext, type PrivateContext } from "../sessions/private-context.ts";
import { validEmail } from "../identity/external-members.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail } from "../admin/invite-email.ts";
import { appShareScope } from "../deploy/email-access.ts";
import { errMessage } from "../util/errors.ts";
import { DeployAccessError, type Reach } from "../deploy/deploy-service.ts";
import { mintDeployGitAccess } from "../deploy/access-token.ts";

import type { Tenant } from "../tenants/context.ts";
import type { App, AppDeps, ViewerApp } from "./app-types.ts";
import { appView } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { appSubdomainUrlOf, type PublishedApp } from "../deploy/deploy-store.ts";

export function createAppMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "deploy"
  | "redeploy"
  | "listApps"
  | "getApp"
  | "shareApp"
  | "inviteToApp"
  | "appGrantees"
  | "appUrl"
  | "listAppsForViewer"
  | "effectiveAppPermission"
  | "appGitPermissionFor"
  | "appGitPermissionsFor"
  | "rollbackApp"
  | "canManageApp"
  | "archiveApp"
  | "restoreApp"
  | "renameApp"
  | "setAppDisplayName"
  | "setAppAlwaysOn"
  | "setAppEmbedAncestors"
  | "setAppPublic"
  | "setAppConnectors"
  | "maintainApps"
  | "publishDueLiveEdits"
  | "appLiveEdit"
  | "reachApp"
  | "appLogsFor"
  | "appGitRepoPath"
  | "runAppGitPush"
  | "runAppGitRead"
  | "appGitUrlFor"
  | "authorizesAppGitAccess"
  | "reapIdleApps"
  | "listEnvironments"
  | "createEnvironment"
  | "resolveEnvironmentByName"
  | "attachScope"
> {
  const { effectiveAppPermission, principalCanReadApp, principalGitPermission, appPermissions } = h;
  async function forCaller(
    d: PublishedApp,
    caller: PrivateContext,
    permission: "read" | "write" | null,
  ): Promise<"read" | "write" | null> {
    if (permission !== "write" || caller.botActor !== true) return permission;
    return (await deps.deploy.canManageApp(d.id, caller)) ? "write" : "read";
  }
  async function callerGitPermissions(
    tenant: Tenant,
    publishedApps: readonly PublishedApp[],
    caller: PrivateContext,
  ): Promise<Array<"read" | "write" | null>> {
    const permissions = await appPermissions(tenant, publishedApps, caller.actorId);
    const allowed = await Promise.all(publishedApps.map((d, i) => forCaller(d, caller, permissions[i]!)));
    const blocked = await inheritContextSources(
      deps.sessions,
      caller,
      publishedApps.filter((_, i) => allowed[i]),
    );
    return allowed.map((permission, i) => (blocked.has(publishedApps[i]!.id) ? null : permission));
  }
  async function callerGitPermission(d: PublishedApp, caller: PrivateContext): Promise<"read" | "write" | null> {
    const permission = await forCaller(d, caller, await principalGitPermission(d, caller.actorId));
    if (!permission) return null;
    return (await inheritContextSources(deps.sessions, caller, [d])).has(d.id) ? null : permission;
  }
  const invitationLock = deps.advisoryLock;
  return {
    deploy(input) {
      return deps.deploy.deploy(input);
    },
    redeploy(id, input) {
      return deps.deploy.redeploy(id, input);
    },
    listApps() {
      return deps.deploy.listApps();
    },
    getApp(idOrName) {
      return deps.deploy.getApp(idOrName);
    },
    shareApp(idOrName, grantee, permission, actor, opts) {
      return deps.deploy.shareApp(idOrName, grantee, permission, actor, opts);
    },
    async inviteToApp(idOrName, rawEmail, actor, opts) {
      const email = rawEmail.trim().toLowerCase();
      if (!validEmail(email)) throw new Error("a valid email address is required");
      const grantee = await appShareScope(`personal:${email}`, "read");
      const publishedApp = await deps.deploy.getApp(idOrName);
      if (!publishedApp) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      await deps.deploy.assertAppOwner(publishedApp, actor);
      return invitationLock.withLock(`deployment-invite:${publishedApp.id}:${email}`, async () => {
        const previous = await deps.deploy.appGrantees(publishedApp.id);
        const alreadyShared = previous.some((g) => g.scope === grantee);
        const grantees = previous.some((g) => g.scope === grantee && g.permission === "read")
          ? previous
          : await deps.deploy.shareApp(publishedApp.id, grantee, "read", actor, opts);
        const appUrl = appSubdomainUrlOf(publishedApp, deps.deployAppsDomain);
        if (alreadyShared)
          return { grantees, invitation: { emailSent: false, alreadyShared: true, ...(appUrl ? { appUrl } : {}) } };
        let emailSent = false;
        let emailProblem: string | undefined;
        if (opts?.notify === false) emailProblem = "notify was false";
        else if (!deps.inviteMailer) emailProblem = INVITE_EMAIL_NOT_CONFIGURED;
        else if (!appUrl)
          emailProblem = "app URLs are not configured (set DEPLOY_APPS_DOMAIN); share the app link manually";
        else {
          try {
            await deps.inviteMailer.send({
              to: email,
              ...renderInviteEmail({
                to: email,
                brandName: publishedApp.displayName ?? publishedApp.name ?? "a shared app",
                invitedBy: actor.createdBy,
                signInUrl: appUrl,
                expiresAt: null,
                magicLink: false,
              }),
            });
            emailSent = true;
          } catch (e) {
            emailProblem = errMessage(e);
          }
        }
        return {
          grantees,
          invitation: { emailSent, ...(emailProblem ? { emailProblem } : {}), ...(appUrl ? { appUrl } : {}) },
        };
      });
    },
    appGrantees(idOrName) {
      return deps.deploy.appGrantees(idOrName);
    },
    appUrl(publishedApp) {
      return deps.deploy.appUrl?.(publishedApp);
    },
    async listAppsForViewer(tenant, viewer) {
      const publishedApps = await deps.deploy.listApps();
      const permissions = await callerGitPermissions(tenant, publishedApps, viewer);
      return publishedApps.flatMap((d, i): ViewerApp[] => {
        const permission = permissions[i];
        const webUrl = deps.deploy.appUrl?.(d);
        return permission ? [{ ...appView(d), permission, ...(webUrl ? { webUrl } : {}) }] : [];
      });
    },
    effectiveAppPermission(d, principalId) {
      return effectiveAppPermission(d, principalId);
    },
    async appGitPermissionFor(idOrName, viewer) {
      const publishedApp = await deps.deploy.getApp(idOrName);
      return publishedApp ? callerGitPermission(publishedApp, viewer) : null;
    },
    appGitPermissionsFor(tenant, publishedApps, viewer) {
      return callerGitPermissions(tenant, publishedApps, viewer);
    },
    rollbackApp(id, version, actor) {
      return deps.deploy.rollbackApp(id, version, actor ? { actor } : undefined);
    },
    canManageApp(idOrName, caller, actingScopeId) {
      return deps.deploy.canManageApp(idOrName, caller, actingScopeId);
    },
    archiveApp(id, context) {
      return deps.deploy.archiveApp(id, context);
    },
    restoreApp(id, actorId, context) {
      return deps.deploy.restoreApp(id, actorId, context);
    },
    renameApp(id, name, context) {
      return deps.deploy.renameApp(id, name, context);
    },
    setAppDisplayName(id, displayName, context) {
      return deps.deploy.setAppDisplayName(id, displayName, context);
    },
    setAppAlwaysOn(id, alwaysOn, context) {
      return deps.deploy.setAppAlwaysOn(id, alwaysOn, context);
    },
    setAppEmbedAncestors(id, embedAncestors, context) {
      return deps.deploy.setAppEmbedAncestors(id, embedAncestors, context);
    },
    setAppPublic(idOrName, isPublic, actor) {
      return deps.deploy.setAppPublic(idOrName, isPublic, actor);
    },
    setAppConnectors(idOrName, connectors, actor) {
      return deps.deploy.setAppConnectors(idOrName, connectors, actor);
    },
    maintainApps() {
      return deps.deploy.maintainApps();
    },
    publishDueLiveEdits() {
      return deps.deploy.publishDueLiveEdits();
    },
    appLiveEdit(id) {
      return deps.deploy.liveEditOf(id);
    },
    async reachApp(id, principalId, opts): Promise<Reach> {
      const caller = typeof principalId === "string" ? { actorId: principalId } : principalId;
      principalId = caller.actorId;
      const publishedApp = await deps.deploy.getApp(id);
      if (!publishedApp) return { status: "not_found" };
      if (!opts?.bypassAcl && !(await principalCanReadApp(publishedApp, principalId))) return { status: "denied" };
      if ((await inheritContextSources(deps.sessions, caller, [publishedApp])).has(publishedApp.id))
        return { status: "denied" };
      return deps.deploy.reachApp(id, principalId, { bypassAcl: true });
    },
    async appLogsFor(
      id,
      principalId,
      opts,
    ): Promise<{ status: "ok"; logs: string | null } | { status: "not_found" | "denied" }> {
      const caller = typeof principalId === "string" ? { actorId: principalId } : principalId;
      return deps.deploy.readApp(id, async (publishedApp) => {
        if (!publishedApp) return { status: "not_found" };
        if (!(await principalCanReadApp(publishedApp, caller.actorId))) return { status: "denied" };
        if ((await inheritContextSources(deps.sessions, caller, [publishedApp])).has(publishedApp.id))
          return { status: "denied" };
        return { status: "ok", logs: await deps.deploy.appLogs(publishedApp.id, opts) };
      });
    },
    appGitRepoPath(id) {
      return deps.deploy.gitRepoPath(id);
    },
    runAppGitRead(id, runUploadPack) {
      return deps.deploy.readApp(id, (app) => {
        if (!app) throw new DeployAccessError("not_found", `no such app: ${id}`);
        return runUploadPack();
      });
    },
    runAppGitPush(id, actor, runReceivePack) {
      return deps.deploy.pushGit(id, runReceivePack, actor);
    },
    async appGitUrlFor(idOrName, caller, opts) {
      const d = await deps.deploy.getApp(idOrName);
      if (!d) return null;
      const permission = await callerGitPermission(d, caller);
      if (!permission) return null;
      const token = await mintDeployGitAccess(opts.secret, {
        deploymentId: d.id,
        permission,
        principalId: caller.actorId,
        context: {
          ...(caller.scopeId !== undefined ? { scopeId: caller.scopeId } : {}),
          ...(caller.audienceScopeId !== undefined ? { audienceScopeId: caller.audienceScopeId } : {}),
          ...(caller.sessionId !== undefined ? { sessionId: caller.sessionId } : {}),
          privateRead: caller.privateRead === true || (caller.scopeId === undefined && caller.computer === undefined),
          ...(caller.computer ? { computer: caller.computer } : {}),
          ...(caller.personalOnly || d.personalOnly ? { personalOnly: true } : {}),
          ...(caller.botActor !== undefined ? { botActor: caller.botActor } : {}),
        },
        exp: Date.now() + (opts.ttlMs ?? 60 * 60 * 1000),
      });
      const url = new URL(`/v1/apps/${encodeURIComponent(d.id)}/git`, opts.baseUrl);
      url.username = "app";
      url.password = token;
      return { url: url.toString(), permission };
    },
    async authorizesAppGitAccess(id, principalId, permission, context) {
      const d = await deps.deploy.getApp(id);
      if (!d) return false;
      const external = await deps.appGitPrincipals?.authorizes(d, principalId, permission);
      if (external !== undefined) return external;
      if (d.personalOnly && (context?.personalOnly !== true || context.privateRead !== true)) return false;
      if ((d.personalOnly || permission === "write") && !context) return false;
      const caller = { ...context, actorId: principalId, privateRead: context?.privateRead === true };
      await refreshPrivateContext(deps.sessions, caller);
      const current = await callerGitPermission(d, caller);
      return permission === "write" ? current === "write" : current !== null;
    },
    reapIdleApps(ttlMs, now) {
      return deps.deploy.reapIdleApps(ttlMs, now);
    },

    async listEnvironments() {
      if (!deps.environments) return [];
      const envs = await deps.environments.list();
      return Promise.all(
        envs.map(async (environment) => ({
          environment,
          attachments: await deps.environments!.attachmentsFor(environment.id),
        })),
      );
    },
    async createEnvironment(input) {
      if (!deps.environments) throw new Error("environments not wired");
      const env = await deps.environments.create({
        id: input.scopeId,
        name: input.name,
        ownerActorId: input.actorId,
      });
      h.recordAudit({
        at: Date.now(),
        principalId: input.actorId,
        action: "environment_create",
        resource: env.id,
        scopeLabel: input.scopeId,
      });
      return env;
    },
    resolveEnvironmentByName(name) {
      if (!deps.environments) return Promise.resolve(null);
      return deps.environments.list().then((envs) => envs.find((e) => e.name === name) ?? null);
    },
    async attachScope(input) {
      if (!deps.environments) throw new Error("environments not wired");
      await deps.environments.attach(input.scopeId, input.environmentId, input.actorId);
      h.recordAudit({
        at: Date.now(),
        principalId: input.actorId,
        action: "environment_attach",
        resource: input.environmentId,
        scopeLabel: input.scopeId,
      });
    },
  };
}
