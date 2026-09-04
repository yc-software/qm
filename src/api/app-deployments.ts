import type { Reach } from "../deploy/deploy-service.ts";
import { mintDeployGitAccess } from "../deploy/access-token.ts";

import type { App, AppDeps, ViewerDeployment } from "./app-types.ts";
import { deploymentView } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

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
    deploymentGrantees(idOrName) {
      return deps.deploy.deploymentGrantees(idOrName);
    },
    async listDeploymentsForViewer(principalId) {
      const deployments = await deps.deploy.listDeployments();
      const enriched = await Promise.all(
        deployments.map(async (d): Promise<ViewerDeployment | null> => {
          const permission = await principalGitPermission(d, principalId);
          return permission ? { ...deploymentView(d), permission } : null;
        }),
      );
      return enriched.filter((d): d is ViewerDeployment => d != null);
    },
    effectiveDeploymentPermission(d, principalId) {
      return effectiveDeploymentPermission(d, principalId);
    },
    async deploymentGitPermissionFor(idOrName, principalId) {
      const deployment = (await deps.deploy.listDeployments()).find((d) => d.id === idOrName || d.name === idOrName);
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
      const token = await mintDeployGitAccess(opts.secret, {
        deploymentId: d.id,
        permission,
        principalId,
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
