import { validEmail } from "../identity/external-members.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail } from "../admin/invite-email.ts";
import { deploymentShareScope } from "../deploy/email-access.ts";
import { errMessage } from "../util/errors.ts";
import { DeployAccessError, type Reach } from "../deploy/deploy-service.ts";
import { mintDeployGitAccess } from "../deploy/access-token.ts";
import { appHostLabel } from "../tenants/app-handle.ts";
import { tenantAppHandle } from "../tenants/settings.ts";

import type { App, AppDeps, ViewerDeployment } from "./app-types.ts";
import { deploymentView } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { proactiveScopeWork, type ManagingCaller } from "../auth/capability-token.ts";
import type { Deployment } from "../deploy/deploy-store.ts";

export function createDeploymentMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "deploy"
  | "redeploy"
  | "listDeployments"
  | "getDeployment"
  | "shareDeployment"
  | "inviteToDeployment"
  | "deploymentGrantees"
  | "listDeploymentsForViewer"
  | "effectiveDeploymentPermission"
  | "deploymentGitPermissionFor"
  | "rollbackDeployment"
  | "canManageDeployment"
  | "archiveDeployment"
  | "restoreDeployment"
  | "renameDeployment"
  | "setDeploymentDisplayName"
  | "setDeploymentAlwaysOn"
  | "setDeploymentEmbedAncestors"
  | "setDeploymentPublic"
  | "setDeploymentConnectors"
  | "maintainDeployments"
  | "publishDueLiveEdits"
  | "deploymentLiveEdit"
  | "reachDeployment"
  | "deploymentLogsFor"
  | "deploymentGitRepoPath"
  | "runDeploymentGitPush"
  | "deploymentGitUrlFor"
  | "authorizesDeploymentGitAccess"
  | "reapIdleDeployments"
  | "listEnvironments"
  | "createEnvironment"
  | "resolveEnvironmentByName"
  | "attachScope"
> {
  const { effectiveDeploymentPermission, principalCanReadDeployment, principalGitPermission } = h;
  async function callerGitPermission(d: Deployment, caller: ManagingCaller): Promise<"read" | "write" | null> {
    const permission = await principalGitPermission(d, caller.actorId);
    if (permission !== "write") return permission;
    if (proactiveScopeWork(caller)) return "read";
    if (caller.botActor !== true) return permission;
    return (await deps.deploy.canManageDeployment(d.id, caller)) ? "write" : "read";
  }
  const invitationLock = deps.advisoryLock;
  return {
    deploy(input) {
      return deps.deploy.deploy(input);
    },
    redeploy(id, input) {
      return deps.deploy.redeploy(id, input);
    },
    listDeployments() {
      return deps.deploy.listDeployments();
    },
    getDeployment(idOrName) {
      return deps.deploy.getDeployment(idOrName);
    },
    shareDeployment(idOrName, grantee, permission, actor, opts) {
      return deps.deploy.shareDeployment(idOrName, grantee, permission, actor, opts);
    },
    async inviteToDeployment(idOrName, rawEmail, actor, opts) {
      const email = rawEmail.trim().toLowerCase();
      if (!validEmail(email)) throw new Error("a valid email address is required");
      const grantee = await deploymentShareScope(`personal:${email}`, "read");
      const deployment = await deps.deploy.getDeployment(idOrName);
      if (!deployment) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      await deps.deploy.assertDeploymentOwner(deployment, actor);
      return invitationLock.withLock(`deployment-invite:${deployment.id}:${email}`, async () => {
        const previous = await deps.deploy.deploymentGrantees(deployment.id);
        const alreadyShared = previous.some((g) => g.scope === grantee);
        const grantees = previous.some((g) => g.scope === grantee && g.permission === "read")
          ? previous
          : await deps.deploy.shareDeployment(deployment.id, grantee, "read", actor, opts);
        const handle = tenantAppHandle();
        const appUrl =
          deps.deployAppsDomain && handle
            ? `https://${appHostLabel(handle, deployment.name ?? deployment.id)}.${deps.deployAppsDomain}/`
            : undefined;
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
                brandName: deployment.displayName ?? deployment.name ?? "a shared app",
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
    deploymentGrantees(idOrName) {
      return deps.deploy.deploymentGrantees(idOrName);
    },
    async listDeploymentsForViewer(viewer) {
      const deployments = await deps.deploy.listDeployments();
      const enriched = await Promise.all(
        deployments.map(async (d): Promise<ViewerDeployment | null> => {
          const permission = await callerGitPermission(d, viewer);
          return permission ? { ...deploymentView(d), permission } : null;
        }),
      );
      return enriched.filter((d): d is ViewerDeployment => d != null);
    },
    effectiveDeploymentPermission(d, principalId) {
      return effectiveDeploymentPermission(d, principalId);
    },
    async deploymentGitPermissionFor(idOrName, viewer) {
      const deployment = await deps.deploy.getDeployment(idOrName);
      return deployment ? callerGitPermission(deployment, viewer) : null;
    },
    rollbackDeployment(id, version, actor) {
      return deps.deploy.rollbackDeployment(id, version, actor ? { actor } : undefined);
    },
    canManageDeployment(idOrName, caller, actingScopeId) {
      return deps.deploy.canManageDeployment(idOrName, caller, actingScopeId);
    },
    archiveDeployment(id) {
      return deps.deploy.archiveDeployment(id);
    },
    restoreDeployment(id, actorId) {
      return deps.deploy.restoreDeployment(id, actorId);
    },
    renameDeployment(id, name) {
      return deps.deploy.renameDeployment(id, name);
    },
    setDeploymentDisplayName(id, displayName) {
      return deps.deploy.setDeploymentDisplayName(id, displayName);
    },
    setDeploymentAlwaysOn(id, alwaysOn) {
      return deps.deploy.setDeploymentAlwaysOn(id, alwaysOn);
    },
    setDeploymentEmbedAncestors(id, embedAncestors) {
      return deps.deploy.setDeploymentEmbedAncestors(id, embedAncestors);
    },
    setDeploymentPublic(idOrName, isPublic, actor) {
      return deps.deploy.setDeploymentPublic(idOrName, isPublic, actor);
    },
    setDeploymentConnectors(idOrName, connectors, actor) {
      return deps.deploy.setDeploymentConnectors(idOrName, connectors, actor);
    },
    maintainDeployments() {
      return deps.deploy.maintainDeployments();
    },
    publishDueLiveEdits() {
      return deps.deploy.publishDueLiveEdits();
    },
    deploymentLiveEdit(id) {
      return deps.deploy.liveEditOf(id);
    },
    async reachDeployment(id, principalId, opts): Promise<Reach> {
      if (opts?.bypassAcl) return deps.deploy.reachDeployment(id, principalId, opts);
      const deployment = await deps.deploy.getDeployment(id);
      if (!deployment) return { status: "not_found" };
      if (!(await principalCanReadDeployment(deployment, principalId))) return { status: "denied" };
      return deps.deploy.reachDeployment(id, principalId, { bypassAcl: true });
    },
    async deploymentLogsFor(
      id,
      principalId,
      opts,
    ): Promise<{ status: "ok"; logs: string | null } | { status: "not_found" | "denied" }> {
      const deployment = await deps.deploy.getDeployment(id);
      if (!deployment) return { status: "not_found" };
      if (!(await principalCanReadDeployment(deployment, principalId))) return { status: "denied" };
      return { status: "ok", logs: await deps.deploy.deploymentLogs(id, opts) };
    },
    deploymentGitRepoPath(id) {
      return deps.deploy.gitRepoPath(id);
    },
    runDeploymentGitPush(id, actor, runReceivePack) {
      return deps.deploy.pushGit(id, runReceivePack, actor);
    },
    async deploymentGitUrlFor(idOrName, caller, opts) {
      const d = await deps.deploy.getDeployment(idOrName);
      if (!d) return null;
      const permission = await callerGitPermission(d, caller);
      if (!permission) return null;
      const token = await mintDeployGitAccess(opts.secret, {
        deploymentId: d.id,
        permission,
        principalId: caller.actorId,
        exp: Date.now() + (opts.ttlMs ?? 60 * 60 * 1000),
      });
      const url = new URL(`/v1/deployments/${encodeURIComponent(d.id)}/git`, opts.baseUrl);
      url.username = "deployment";
      url.password = token;
      return { url: url.toString(), permission };
    },
    async authorizesDeploymentGitAccess(id, principalId, permission) {
      const d = await deps.deploy.getDeployment(id);
      if (!d) return false;
      const external = await deps.deploymentGitPrincipals?.authorizes(d, principalId, permission);
      if (external !== undefined) return external;
      const current = await principalGitPermission(d, principalId);
      return permission === "write" ? current === "write" : current !== null;
    },
    reapIdleDeployments(ttlMs, now) {
      return deps.deploy.reapIdleDeployments(ttlMs, now);
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
