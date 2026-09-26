import { validEmail } from "../identity/external-members.ts";
import { createMemoryAdvisoryLock } from "../persistence/advisory-lock.ts";
import { INVITE_EMAIL_NOT_CONFIGURED, renderInviteEmail } from "../admin/invite-email.ts";
import { deploymentShareScope } from "../deploy/email-access.ts";
import { errMessage } from "../util/errors.ts";
import type { Reach } from "../deploy/deploy-service.ts";
import { mintDeployGitAccess } from "../deploy/access-token.ts";
import type { Deployment } from "../deploy/deploy-store.ts";

import type { App, AppDeps, DeploymentGitUrlOptions, ViewerDeployment } from "./app-types.ts";
import { deploymentView } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

async function deploymentGitUrl(
  id: string,
  principalId: string,
  permission: "read" | "write",
  opts: DeploymentGitUrlOptions,
) {
  const token = await mintDeployGitAccess(opts.secret, {
    deploymentId: id,
    permission,
    principalId,
    exp: Date.now() + (opts.ttlMs ?? 60 * 60 * 1000),
  });
  const url = new URL(`/v1/deployments/${encodeURIComponent(id)}/git`, opts.baseUrl);
  url.username = "deployment";
  url.password = token;
  return { url: url.toString(), permission };
}

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
  | "getDeploymentForViewer"
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
  | "keepAlwaysOnWarm"
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
  const invitationLock = deps.advisoryLock ?? createMemoryAdvisoryLock();
  async function viewerDeployment(
    deployment: Deployment,
    principalId: string,
    git?: DeploymentGitUrlOptions,
  ): Promise<ViewerDeployment | null> {
    const permission = await principalGitPermission(deployment, principalId);
    if (!permission) return null;
    return {
      ...deploymentView(deployment),
      permission,
      ...(git ? { gitUrl: (await deploymentGitUrl(deployment.id, principalId, permission, git)).url } : {}),
    };
  }
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
    shareDeployment(idOrName, grantee, permission, actor) {
      return deps.deploy.shareDeployment(idOrName, grantee, permission, actor);
    },
    async inviteToDeployment(idOrName, rawEmail, actorId) {
      const email = rawEmail.trim().toLowerCase();
      if (!validEmail(email)) throw new Error("a valid email address is required");
      const grantee = await deploymentShareScope(`personal:${email}`, "read");
      const deployment = await deps.deploy.getDeployment(idOrName);
      if (!deployment) throw new Error(`no such app: ${idOrName}`);
      if (deployment.ownerScopeId !== `personal:${actorId}`)
        throw new Error(`only the owner can change who can reach "${deployment.name ?? deployment.id}"`);
      return invitationLock.withLock(`deployment-invite:${deployment.id}:${email}`, async () => {
        const previous = await deps.deploy.deploymentGrantees(deployment.id);
        const alreadyShared = previous.some((g) => g.scope === grantee);
        const grantees = previous.some((g) => g.scope === grantee && g.permission === "read")
          ? previous
          : await deps.deploy.shareDeployment(deployment.id, grantee, "read", { createdBy: actorId });
        const appUrl = deps.deployAppsDomain
          ? `https://${deployment.name ?? deployment.id}.${deps.deployAppsDomain}/`
          : undefined;
        if (alreadyShared)
          return { grantees, invitation: { emailSent: false, alreadyShared: true, ...(appUrl ? { appUrl } : {}) } };
        let emailSent = false;
        let emailProblem: string | undefined;
        if (!deps.inviteMailer) emailProblem = INVITE_EMAIL_NOT_CONFIGURED;
        else if (!appUrl)
          emailProblem = "app URLs are not configured (set DEPLOY_APPS_DOMAIN); share the app link manually";
        else {
          try {
            await deps.inviteMailer.send({
              to: email,
              ...renderInviteEmail({
                to: email,
                brandName: deployment.displayName ?? deployment.name ?? "a shared app",
                invitedBy: actorId,
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
    async listDeploymentsForViewer(principalId, git) {
      const deployments = await deps.deploy.listDeployments();
      const enriched = await Promise.all(deployments.map((d) => viewerDeployment(d, principalId, git)));
      return enriched.filter((d): d is ViewerDeployment => d != null);
    },
    async getDeploymentForViewer(idOrName, principalId, git) {
      const deployment = await deps.deploy.getDeployment(idOrName);
      return deployment ? viewerDeployment(deployment, principalId, git) : null;
    },
    effectiveDeploymentPermission(d, principalId) {
      return effectiveDeploymentPermission(d, principalId);
    },
    async deploymentGitPermissionFor(idOrName, principalId) {
      const deployment = await deps.deploy.getDeployment(idOrName);
      return deployment ? principalGitPermission(deployment, principalId) : null;
    },
    rollbackDeployment(id, version) {
      return deps.deploy.rollbackDeployment(id, version);
    },
    canManageDeployment(idOrName, callerId, actingScopeId) {
      return deps.deploy.canManageDeployment(idOrName, callerId, actingScopeId);
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
    keepAlwaysOnWarm() {
      return deps.deploy.keepAlwaysOnWarm();
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
    runDeploymentGitPush(id, runReceivePack) {
      return deps.deploy.pushGit(id, runReceivePack);
    },
    async deploymentGitUrlFor(idOrName, principalId, opts) {
      const d = await deps.deploy.getDeployment(idOrName);
      if (!d) return null;
      const permission = await principalGitPermission(d, principalId);
      if (!permission) return null;
      return deploymentGitUrl(d.id, principalId, permission, opts);
    },
    async authorizesDeploymentGitAccess(id, principalId, permission) {
      const d = await deps.deploy.getDeployment(id);
      if (!d) return false;
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
      deps.auditLog.record({
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
      deps.auditLog.record({
        at: Date.now(),
        principalId: input.actorId,
        action: "environment_attach",
        resource: input.environmentId,
        scopeLabel: input.scopeId,
      });
    },
  };
}
