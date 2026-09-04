import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { Grant, Permission, ScopeId } from "../types.ts";
import { isManageableCreationScope, parseScopeId, scopeId } from "../types.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { deployRef, encodeRef } from "../acl/resource-ref.ts";
import { normalizeRelPath } from "./deploy-fs.ts";
import { samePerson } from "../directory/person.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  deployCurrentGitRef,
  type DeployStore,
  type Deployment,
  type DeployEndpoint,
  type DeploymentVersion,
} from "./deploy-store.ts";
import type { DeployProfile, DeployProvider } from "./deploy-provider.ts";
import { createNoopLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue } from "../util/async.ts";
import { errMessage, swallow } from "../util/errors.ts";

export interface DeployFile {
  path: string;
  data: string | Uint8Array;
}

export interface DeployInput {
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  entrypoint: string;
  files: DeployFile[];
  homeFiles?: DeployFile[];
  name?: string;
  env?: Record<string, string>;
}

export type Reach = { status: "ok"; endpoint: DeployEndpoint } | { status: "denied" } | { status: "not_found" };

export interface DeployOrUpdateInput {
  ownerScopeId: ScopeId;
  createdBy: string;
  name?: string;
  entrypoint?: string;
  files?: DeployFile[];
  homeFiles?: DeployFile[];
  env?: Record<string, string>;
  renameFrom?: string;
  rollbackTo?: number;
  share?: Array<{ scope: ScopeId; permission: Permission }>;
  createdInScope?: ScopeId;
  defaultAudience?: { contextScopeId: ScopeId; granteeScopeIds: ScopeId[]; snapshotAt: number; force?: boolean };
}

export interface ReachOptions {
  bypassAcl?: boolean;
}

export interface DeployService {
  readonly providerProfile: DeployProfile;
  deploy(input: DeployInput): Promise<Deployment>;
  redeploy(
    id: string,
    input: { entrypoint: string; files: DeployFile[]; homeFiles?: DeployFile[]; env?: Record<string, string> },
  ): Promise<Deployment>;
  getDeployment(idOrName: string): Promise<Deployment | null>;
  listDeployments(): Promise<Deployment[]>;
  rollbackDeployment(id: string, version: number): Promise<void>;
  archiveDeployment(id: string): Promise<void>;
  restoreDeployment(id: string, actorId?: string): Promise<Deployment>;
  renameDeployment(id: string, name: string): Promise<Deployment>;
  setDeploymentDisplayName(id: string, displayName: string): Promise<Deployment>;
  reachDeployment(idOrName: string, principalId: string, opts?: ReachOptions): Promise<Reach>;
  /** Recent app output (entrypoint stdout+stderr) for a deployment, newest last; null when the provider keeps none. */
  deploymentLogs(idOrName: string, opts: { tailLines: number }): Promise<string | null>;
  gitRepoPath(idOrName: string): Promise<string | null>;
  pushGit<T>(id: string, runReceivePack: () => Promise<{ result: T; ok: boolean }>): Promise<T>;
  reapIdleDeployments(ttlMs: number, now?: number): Promise<number>;
  deployOrUpdate(input: DeployOrUpdateInput): Promise<Deployment>;
  deploymentGrantees(idOrName: string): Promise<DeploymentGrantee[]>;
  canManageDeployment(idOrName: string, callerId: string, actingScopeId?: ScopeId): Promise<boolean>;
  shareDeployment(
    idOrName: string,
    grantee: ScopeId,
    permission: Permission | null,
    actor: { createdBy: string },
  ): Promise<DeploymentGrantee[]>;
  transferDeploymentOwner(
    idOrName: string,
    toScope: ScopeId,
    actor: { callerId: string; actingScopeId?: ScopeId },
  ): Promise<Deployment>;
}

export interface DeploymentGrantee {
  scope: ScopeId;
  permission: Permission;
}

export interface DeployServiceDeps {
  deployStore: DeployStore;
  provider: DeployProvider;
  deployDir: string;
  auditLog: AuditLog;
  acl: AclStore;
  leaderLease?: LeaderLease;
  advisoryLock?: AdvisoryLock;
  canReadScope?: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
  canWriteScope?: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
  managesArtifactHome?: (homeScopeId: ScopeId, createdBy: string, principalId: string) => Promise<boolean>;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateName(name: string): void {
  if (UUID_RE.test(name)) throw new Error(`invalid deployment name (looks like an id): ${name}`);
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid deployment name "${name}": use 2-40 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen`,
    );
  }
}

const DISPLAY_NAME_MAX = 60;
function validateDisplayName(displayName: string): void {
  if (/[\u0000-\u001f\u007f]/.test(displayName)) throw new Error("invalid display name: no control characters");
  if (displayName.length > DISPLAY_NAME_MAX) throw new Error(`display name too long (max ${DISPLAY_NAME_MAX} chars)`);
}

function deploymentEntrypoint(d: Deployment | null): string | undefined {
  if (!d) return undefined;
  return d.versions.find((v) => v.version === d.currentVersion)?.entrypoint || undefined;
}

function requiredEntrypoint(input: string | undefined, d: Deployment | null): string {
  const entrypoint = input ?? deploymentEntrypoint(d);
  if (!entrypoint) throw new Error('publish requires an entrypoint, e.g. "node server.js"');
  return entrypoint;
}

export function createDeployService(deps: DeployServiceDeps): DeployService {
  const leaderLease = deps.leaderLease ?? createNoopLeaderLease();
  const advisoryLock = deps.advisoryLock ?? createNoopAdvisoryLock();
  const deployQueue = createKeyedQueue();
  function withDeployLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return deployQueue(id, () => advisoryLock.withLock(`deploy:${id}`, fn));
  }

  const applyVersion = async (
    id: string,
    version: DeploymentVersion,
    fromVersion?: number,
  ): Promise<DeployEndpoint> => {
    const d = (await deps.deployStore.get(id))!;
    let endpoint: DeployEndpoint;
    if (deps.provider.reconcile && version.commit) {
      const diff = await deps.deployStore.diffVersions(id, fromVersion, version.version);
      const allPaths = ((await deps.deployStore.treeOf(id, version.version)) ?? []).map((f) => f.path);
      const gitBundle = await deps.deployStore.bundleOf(id, version.version);
      endpoint = await deps.provider.reconcile(d, version, {
        ...(gitBundle ? { gitBundle } : {}),
        changedPaths: diff ? [...diff.added, ...diff.modified].map((f) => f.path) : allPaths,
        deletedPaths: diff?.deleted.map((f) => f.path) ?? [],
        allPaths,
      });
    } else {
      let materialized = version;
      if (version.commit) {
        const files = await deps.deployStore.filesOf(id, version.version);
        if (files == null) throw new Error(`cannot materialize deployment ${id} version ${version.version}`);
        materialized = { ...version, snapshotDir: await snapshotFiles(deps.deployDir, files) };
      }
      endpoint = await deps.provider.apply(d, materialized);
    }
    if (endpoint.image && endpoint.image !== version.image) {
      await deps.deployStore.setVersionImage(id, version.version, endpoint.image);
    }
    return endpoint;
  };

  const markVersionRunning = async (id: string, version: number, endpoint: DeployEndpoint): Promise<void> => {
    await deps.deployStore.setEndpoint(id, endpoint);
    await deps.deployStore.setStatus(id, "running");
    await deps.deployStore.setAppliedVersion(id, version);
  };

  const liveEndpoint = async (d: Deployment): Promise<DeployEndpoint> => {
    if (!deps.provider.resolveEndpoint || d.endpoint == null) return d.endpoint!;
    const version = d.versions.find((v) => v.version === d.currentVersion);
    if (!version) return d.endpoint;
    const resolved = await deps.provider.resolveEndpoint(d, version);
    if (resolved) {
      if (!endpointsEqual(resolved, d.endpoint)) await deps.deployStore.setEndpoint(d.id, resolved);
      return resolved;
    }
    return withDeployLock(d.id, async () => {
      const cur = (await deps.deployStore.get(d.id)) ?? d;
      const v = cur.versions.find((x) => x.version === cur.currentVersion) ?? version;
      const again = await deps.provider.resolveEndpoint!(cur, v);
      if (again) {
        if (!endpointsEqual(again, cur.endpoint)) await deps.deployStore.setEndpoint(cur.id, again);
        return again;
      }
      const fresh = await applyVersion(cur.id, v, cur.appliedVersion ?? cur.currentVersion);
      await markVersionRunning(cur.id, v.version, fresh);
      return fresh;
    });
  };

  const deploymentRef = (id: string): string => encodeRef(deployRef(id));
  const grantsOn = (d: Deployment): Promise<Grant[]> => deps.acl.grantsFor(d.ownerScopeId, deploymentRef(d.id));

  async function reachAllowed(d: Deployment, principalId: string): Promise<boolean> {
    if (!principalId) return false;
    const reaches = async (scope: ScopeId): Promise<boolean> => {
      if (deps.canReadScope) return deps.canReadScope(principalId, scope);
      const { kind, ref } = parseScopeId(scope);
      return kind === "org" || (kind === "personal" && samePerson(ref, principalId));
    };
    if (await reaches(d.ownerScopeId)) return true;
    for (const g of await grantsOn(d)) {
      if ((g.permission === "read" || g.permission === "write") && (await reaches(g.granteeScopeId))) return true;
    }
    return false;
  }

  async function canWriteScope(callerId: string, scope: ScopeId, actingScopeId?: ScopeId): Promise<boolean> {
    if (deps.canWriteScope) return deps.canWriteScope(callerId, scope);
    return scope === `personal:${callerId}` || scope === actingScopeId;
  }

  async function managesHome(d: Deployment, callerId: string, actingScopeId?: ScopeId): Promise<boolean> {
    if (d.ownerScopeId === `personal:${callerId}`) return true;
    if (deps.managesArtifactHome && (await deps.managesArtifactHome(d.ownerScopeId, d.createdBy, callerId)))
      return true;
    if (
      isManageableCreationScope(d.createdInScope) &&
      (await canWriteScope(callerId, d.createdInScope!, actingScopeId))
    )
      return true;
    return false;
  }

  async function canManage(
    d: Deployment,
    _ownerScopeId: ScopeId,
    callerId: string,
    actingScopeId?: ScopeId,
  ): Promise<boolean> {
    if (await managesHome(d, callerId, actingScopeId)) return true;
    for (const grant of await grantsOn(d)) {
      if (grant.permission !== "write") continue;
      if (await canWriteScope(callerId, grant.granteeScopeId, actingScopeId)) return true;
    }
    return false;
  }

  async function reconcileDefaultAudience(
    d: Deployment,
    da: NonNullable<DeployOrUpdateInput["defaultAudience"]>,
    isCreate: boolean,
  ): Promise<void> {
    if (!isCreate && !da.force && d.createdInScope && da.contextScopeId !== d.createdInScope) return;
    const ref = deploymentRef(d.id);
    const owner = d.createdBy;
    const prior = isCreate ? [] : (d.defaultAudience?.granteeScopeIds ?? []);
    const priorSet = new Set(prior);
    const nextSet = new Set(da.granteeScopeIds);
    const before = await grantsOn(d);
    for (const grantee of prior) {
      if (nextSet.has(grantee)) continue;
      const explicit = before.filter((g) => g.granteeScopeId === grantee && g.permission !== "read");
      await deps.acl.revoke(d.ownerScopeId, ref, grantee, owner);
      for (const g of explicit) await deps.acl.grant(g);
      deps.auditLog.record({
        at: Date.now(),
        principalId: owner,
        action: "deploy_unshare",
        resource: ref,
        scopeLabel: grantee,
      });
    }
    for (const grantee of da.granteeScopeIds) {
      if (priorSet.has(grantee)) continue;
      await deps.acl.grant({
        ownerScopeId: d.ownerScopeId,
        ref,
        granteeScopeId: grantee,
        permission: "read",
        grantedBy: owner,
      });
      deps.auditLog.record({
        at: Date.now(),
        principalId: owner,
        action: "deploy_share",
        resource: ref,
        scopeLabel: grantee,
      });
    }
    await deps.deployStore.setDefaultAudience(d.id, {
      sourceScopeId: d.createdInScope ?? da.contextScopeId,
      granteeScopeIds: da.granteeScopeIds,
      snapshotAt: da.snapshotAt,
    });
  }

  async function issueShares(
    d: Deployment,
    createdBy: string,
    share: NonNullable<DeployOrUpdateInput["share"]>,
  ): Promise<void> {
    for (const s of share) {
      const grant: Grant = {
        ownerScopeId: d.ownerScopeId,
        ref: deploymentRef(d.id),
        granteeScopeId: s.scope,
        permission: s.permission,
        grantedBy: createdBy,
      };
      await deps.acl.grant(grant);
      deps.auditLog.record({
        at: Date.now(),
        principalId: createdBy,
        action: "deploy_share",
        resource: deploymentRef(d.id),
        scopeLabel: s.scope,
      });
    }
  }

  return {
    providerProfile: deps.provider.profile,

    async deploy(input) {
      if (input.name !== undefined) {
        validateName(input.name);
        if (await deps.deployStore.getByName(input.name)) throw new Error(`deployment name taken: ${input.name}`);
      }
      const snapshotDir = await snapshotFiles(deps.deployDir, input.files);
      const homeDir = input.homeFiles?.length ? await snapshotFiles(deps.deployDir, input.homeFiles) : undefined;
      const d = await deps.deployStore.create({
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        entrypoint: input.entrypoint,
        snapshotDir,
        files: input.files,
        ...(homeDir ? { homeDir } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdInScope !== undefined ? { createdInScope: input.createdInScope } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      const endpoint = await applyVersion(d.id, d.versions[0]!);
      await markVersionRunning(d.id, d.versions[0]!.version, endpoint);
      deps.auditLog.record({
        at: Date.now(),
        principalId: input.createdBy,
        action: "deploy",
        resource: d.id,
        scopeLabel: input.ownerScopeId,
      });
      return (await deps.deployStore.get(d.id))!;
    },

    async redeploy(id, input) {
      return withDeployLock(id, async () => {
        const before = await deps.deployStore.get(id);
        const snapshotDir = await snapshotFiles(deps.deployDir, input.files);
        const homeDir = input.homeFiles?.length ? await snapshotFiles(deps.deployDir, input.homeFiles) : undefined;
        const v = await deps.deployStore.addVersion(id, {
          entrypoint: input.entrypoint,
          snapshotDir,
          files: input.files,
          ...(homeDir ? { homeDir } : {}),
          ...(input.env ? { env: input.env } : {}),
        });
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        const endpoint = await applyVersion(id, v, before?.appliedVersion ?? before?.currentVersion);
        await markVersionRunning(id, v.version, endpoint);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_version",
          resource: `${id}@v${v.version}`,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async getDeployment(idOrName) {
      return (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
    },

    listDeployments() {
      return deps.deployStore.list();
    },

    async rollbackDeployment(id, version) {
      return withDeployLock(id, async () => {
        const before = await deps.deployStore.get(id);
        await deps.deployStore.setCurrentVersion(id, version);
        const v = await deps.deployStore.versionOf(id, version);
        const d = await deps.deployStore.get(id);
        if (!d || !v) return;
        const endpoint = await applyVersion(id, v, before?.appliedVersion ?? before?.currentVersion);
        await markVersionRunning(id, v.version, endpoint);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_rollback",
          resource: `${id}@v${version}`,
          scopeLabel: d.ownerScopeId,
        });
      });
    },

    async archiveDeployment(id) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) return;
        await deps.provider.destroy(d);
        await deps.deployStore.setStatus(id, "archived");
        await deps.deployStore.setEndpoint(id, null);
      });
    },

    async restoreDeployment(id, actorId) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        if (d.status === "running") return d;
        if (d.status !== "archived") throw new Error(`deployment is not archived: ${id}`);
        const version = d.versions.find((v) => v.version === d.currentVersion);
        if (!version) throw new Error(`no such version ${d.currentVersion}`);
        try {
          const endpoint = await applyVersion(id, version, d.appliedVersion);
          await markVersionRunning(id, version.version, endpoint);
        } catch (error) {
          await deps.provider
            .destroy(d)
            .catch((cleanupError) => swallow("deploy restore runtime cleanup", cleanupError));
          await deps.deployStore
            .setStatus(id, "archived")
            .catch((cleanupError) => swallow("deploy restore status cleanup", cleanupError));
          await deps.deployStore
            .setEndpoint(id, null)
            .catch((cleanupError) => swallow("deploy restore endpoint cleanup", cleanupError));
          throw error;
        }
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId ?? d.createdBy,
          action: "deploy_restore",
          resource: `${id}@v${version.version}`,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async renameDeployment(id, name) {
      return withDeployLock(id, async () => {
        validateName(name);
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        const clash = await deps.deployStore.getByName(name);
        if (clash && clash.id !== id) throw new Error(`deployment name taken: ${name}`);
        await deps.deployStore.setName(id, name);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_rename",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setDeploymentDisplayName(id, displayName) {
      return withDeployLock(id, async () => {
        if (displayName) validateDisplayName(displayName);
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        await deps.deployStore.setDisplayName(id, displayName || undefined);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_display_name",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async reachDeployment(idOrName, principalId, opts = {}): Promise<Reach> {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d || d.status !== "running" || d.endpoint == null) return { status: "not_found" };
      if (!opts.bypassAcl && !(await reachAllowed(d, principalId))) return { status: "denied" };
      const endpoint = await liveEndpoint(d);
      await deps.deployStore.touch(d.id, Date.now());
      return { status: "ok", endpoint };
    },

    async deploymentLogs(idOrName, opts): Promise<string | null> {
      if (!deps.provider.logs) return null;
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d || d.status !== "running") return null;
      return deps.provider.logs(d, opts);
    },

    async gitRepoPath(idOrName) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      return d ? await deps.deployStore.repoUrl(d.id) : null;
    },

    async pushGit(id, runReceivePack) {
      return withDeployLock(id, async () => {
        const { result, ok } = await runReceivePack();
        if (!ok) return result;
        let ownerScopeId = "unknown";
        try {
          const before = await deps.deployStore.get(id);
          if (!before) return result;
          ownerScopeId = before.ownerScopeId;
          const pushed = await deps.deployStore.refOf(id, deployCurrentGitRef);
          if (!pushed) return result;
          const v = await deps.deployStore.addVersionFromCommit(id, pushed);
          if (!v) return result;
          const endpoint = await applyVersion(id, v, before.appliedVersion ?? before.currentVersion);
          await markVersionRunning(id, v.version, endpoint);
          deps.auditLog.record({
            at: Date.now(),
            principalId: before.createdBy,
            action: "deploy_git_push",
            resource: `${id}@v${v.version}`,
            scopeLabel: before.ownerScopeId,
          });
        } catch (e) {
          console.error(`[deploy] failed to register pushed version for ${id}:`, errMessage(e));
          deps.auditLog.record({
            at: Date.now(),
            principalId: "system",
            action: "deploy_git_push_failed",
            resource: id,
            scopeLabel: ownerScopeId,
            status: "error",
          });
        }
        return result;
      });
    },

    async reapIdleDeployments(ttlMs, now = Date.now()) {
      const result = await leaderLease.hold("deployments:reaper", async () => {
        if (deps.provider.profile.managedScaleToZero) return 0;
        let stopped = 0;
        for (const d of await deps.deployStore.list()) {
          if (d.status !== "running") continue;
          const last = d.lastAccessAt ?? d.versions[d.versions.length - 1]?.createdAt ?? 0;
          if (now - last < ttlMs) continue;
          await withDeployLock(d.id, async () => {
            const cur = await deps.deployStore.get(d.id);
            if (!cur || cur.status !== "running") return;
            await deps.provider.destroy(cur);
            await deps.deployStore.setStatus(d.id, "stopped");
            await deps.deployStore.setEndpoint(d.id, null);
            stopped++;
          });
        }
        return stopped;
      });
      return result ?? 0;
    },

    async deployOrUpdate(input) {
      const { ownerScopeId, createdBy } = input;

      if (input.renameFrom !== undefined) {
        if (input.name === undefined) throw new Error("rename requires a target name");
        validateName(input.name);
        const existing = await deps.deployStore.getByName(input.renameFrom);
        if (!existing) throw new Error(`no deployment named: ${input.renameFrom}`);
        if (!(await canManage(existing, ownerScopeId, createdBy, input.createdInScope)))
          throw new Error(`not authorized to manage deployment: ${input.renameFrom}`);
        const clash = await deps.deployStore.getByName(input.name);
        if (clash && clash.id !== existing.id) throw new Error(`deployment name taken: ${input.name}`);
        await deps.deployStore.setName(existing.id, input.name);
        deps.auditLog.record({
          at: Date.now(),
          principalId: createdBy,
          action: "deploy_rename",
          resource: existing.id,
          scopeLabel: existing.ownerScopeId,
        });
        if ((input.entrypoint !== undefined || input.files !== undefined) && input.files) {
          const entrypoint = requiredEntrypoint(input.entrypoint, existing);
          await this.redeploy(existing.id, {
            entrypoint,
            files: input.files,
            ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
            ...(input.env ? { env: input.env } : {}),
          });
          if (input.defaultAudience)
            await reconcileDefaultAudience((await deps.deployStore.get(existing.id))!, input.defaultAudience, false);
        }
        if (input.share?.length) await issueShares((await deps.deployStore.get(existing.id))!, createdBy, input.share);
        return (await deps.deployStore.get(existing.id))!;
      }

      if (input.rollbackTo !== undefined) {
        if (input.name === undefined) throw new Error("rollback requires the deployment name");
        const existing = await deps.deployStore.getByName(input.name);
        if (!existing) throw new Error(`no deployment named: ${input.name}`);
        if (!(await canManage(existing, ownerScopeId, createdBy, input.createdInScope)))
          throw new Error(`not authorized to manage deployment: ${input.name}`);
        await this.rollbackDeployment(existing.id, input.rollbackTo);
        if (input.share?.length) await issueShares((await deps.deployStore.get(existing.id))!, createdBy, input.share);
        return (await deps.deployStore.get(existing.id))!;
      }

      const files = input.files ?? [];
      const existing = input.name !== undefined ? await deps.deployStore.getByName(input.name) : null;
      let d: Deployment;
      let isCreate: boolean;
      if (existing) {
        if (
          existing.ownerScopeId !== ownerScopeId &&
          !(await canManage(existing, ownerScopeId, createdBy, input.createdInScope))
        ) {
          throw new Error(`deployment name taken: ${input.name}`);
        }
        const entrypoint = requiredEntrypoint(input.entrypoint, existing);
        d = await this.redeploy(existing.id, {
          entrypoint,
          files,
          ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
          ...(input.env ? { env: input.env } : {}),
        });
        isCreate = false;
      } else {
        const entrypoint = requiredEntrypoint(input.entrypoint, existing);
        d = await this.deploy({
          ownerScopeId,
          createdBy,
          entrypoint,
          files,
          ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.createdInScope !== undefined ? { createdInScope: input.createdInScope } : {}),
          ...(input.env ? { env: input.env } : {}),
        });
        isCreate = true;
      }
      if (input.defaultAudience)
        await reconcileDefaultAudience((await deps.deployStore.get(d.id))!, input.defaultAudience, isCreate);
      if (input.share?.length) await issueShares((await deps.deployStore.get(d.id))!, createdBy, input.share);
      return (await deps.deployStore.get(d.id))!;
    },

    async canManageDeployment(idOrName, callerId, actingScopeId) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) return false;
      return canManage(d, scopeId("personal", callerId), callerId, actingScopeId);
    },

    async deploymentGrantees(idOrName) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) return [];
      return (await grantsOn(d)).map((g) => ({ scope: g.granteeScopeId, permission: g.permission }));
    },

    async shareDeployment(idOrName, grantee, permission, actor) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) throw new Error(`no such app: ${idOrName}`);
      if (d.ownerScopeId !== scopeId("personal", actor.createdBy)) {
        throw new Error(`only the owner can change who can reach "${d.name ?? d.id}"`);
      }
      const ref = deploymentRef(d.id);
      await deps.acl.revoke(d.ownerScopeId, ref, grantee, actor.createdBy);
      if (permission === null) {
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.createdBy,
          action: "deploy_unshare",
          resource: ref,
          scopeLabel: grantee,
        });
      } else {
        await deps.acl.grant({
          ownerScopeId: d.ownerScopeId,
          ref,
          granteeScopeId: grantee,
          permission,
          grantedBy: actor.createdBy,
        });
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.createdBy,
          action: "deploy_share",
          resource: ref,
          scopeLabel: grantee,
        });
      }
      return (await grantsOn(d)).map((g) => ({ scope: g.granteeScopeId, permission: g.permission }));
    },

    async transferDeploymentOwner(idOrName, toScope, actor) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) throw new Error(`no such app: ${idOrName}`);
      if (!(await managesHome(d, actor.callerId, actor.actingScopeId))) {
        throw new Error(`only the owner can transfer "${d.name ?? d.id}"`);
      }
      if (d.ownerScopeId === toScope) return d;
      const ref = deploymentRef(d.id);
      const fromScope = d.ownerScopeId;
      const prior = await grantsOn(d);
      const newOwnerId = parseScopeId(toScope).kind === "personal" ? parseScopeId(toScope).ref! : actor.callerId;
      const oldOwnerId = parseScopeId(fromScope).kind === "personal" ? parseScopeId(fromScope).ref! : actor.callerId;
      for (const g of prior) {
        if (g.granteeScopeId === toScope) continue;
        await deps.acl.grant({ ...g, ownerScopeId: toScope, grantedBy: newOwnerId }, d.createdBy);
      }
      await deps.acl.grant(
        { ownerScopeId: toScope, ref, granteeScopeId: fromScope, permission: "write", grantedBy: newOwnerId },
        d.createdBy,
      );
      await deps.deployStore.setOwnerScope(d.id, toScope);
      for (const g of prior) await deps.acl.revoke(fromScope, ref, g.granteeScopeId, oldOwnerId, d.createdBy);
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.callerId,
        action: "deploy_transfer",
        resource: ref,
        scopeLabel: toScope,
      });
      return (await deps.deployStore.get(d.id))!;
    },
  };
}

function endpointsEqual(a: DeployEndpoint, b: DeployEndpoint | null): boolean {
  return b != null && JSON.stringify(a) === JSON.stringify(b);
}

async function snapshotFiles(deployDir: string, files: DeployFile[]): Promise<string> {
  const dir = join(deployDir, randomUUID());
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const target = resolve(dir, normalizeRelPath(f.path));
    const rel = relative(dir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`deploy file escapes snapshot: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    if (typeof f.data === "string") await writeFile(target, f.data, "utf8");
    else await writeFile(target, Buffer.from(f.data));
  }
  return dir;
}
