import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { swallow } from "../util/errors.ts";
import {
  createDeployGitStore,
  type DeployGitDiff,
  type DeployGitInputFile,
  type DeployGitStore,
  type DeployGitStoreOptions,
  type DeployGitTreeFile,
} from "./deploy-git-store.ts";

export interface DeploymentVersion {
  version: number;
  createdAt: number;
  entrypoint: string;
  snapshotDir: string;
  homeDir?: string;
  image?: string;
  sourceHash?: string;
  commit?: string;
  parentCommit?: string;
  env?: Record<string, string>;
}

export interface DeployEndpoint {
  host: string;
  port: number;
  publicUrl?: string;
  image?: string;
  tls?: boolean;
  httpVersion?: "1.1" | "2";
  proxyHeaders?: Record<string, string>;
}

export function publicUrlOf(endpoint: DeployEndpoint | null | undefined): string | undefined {
  const raw = endpoint?.publicUrl;
  if (!raw) return raw ?? undefined;
  try {
    const u = new URL(raw);
    u.searchParams.delete("access");
    return u.toString();
  } catch {
    return raw;
  }
}

type DeploymentStatus = "deploying" | "running" | "stopped" | "failed" | "archived";

interface DefaultAudienceSnapshot {
  sourceScopeId: ScopeId;
  granteeScopeIds: ScopeId[];
  snapshotAt: number;
}

export interface Deployment {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  defaultAudience?: DefaultAudienceSnapshot;
  name?: string;
  displayName?: string;
  currentVersion: number;
  status: DeploymentStatus;
  endpoint: DeployEndpoint | null;
  lastAccessAt?: number;
  appliedVersion?: number;
  deployingVersion?: number;
  versions: DeploymentVersion[];
}

interface VersionInput {
  entrypoint: string;
  snapshotDir: string;
  homeDir?: string;
  env?: Record<string, string>;
  files?: DeployGitInputFile[];
  sourceHash?: string;
}

export interface DeployStore {
  create(
    input: { ownerScopeId: ScopeId; createdBy: string; name?: string; createdInScope?: ScopeId } & VersionInput,
  ): Promise<Deployment>;
  addVersion(id: string, input: VersionInput): Promise<DeploymentVersion>;
  addVersionFromCommit(id: string, commit: string): Promise<DeploymentVersion | null>;
  get(id: string): Promise<Deployment | null>;
  getByName(name: string): Promise<Deployment | null>;
  list(): Promise<Deployment[]>;
  setCurrentVersion(id: string, version: number): Promise<void>;
  setVersionImage(id: string, version: number, image: string): Promise<void>;
  setStatus(id: string, status: DeploymentStatus): Promise<void>;
  setEndpoint(id: string, endpoint: DeployEndpoint | null): Promise<void>;
  markDeploying(id: string, version: number): Promise<void>;
  markFailed(id: string): Promise<void>;
  markApplied(id: string, version: number, endpoint: DeployEndpoint): Promise<void>;
  markArchived(id: string): Promise<void>;
  markStopped(id: string): Promise<void>;
  markRuntimeClean(id: string): Promise<void>;
  setName(id: string, name: string): Promise<void>;
  setOwnerScope(id: string, ownerScopeId: ScopeId): Promise<void>;
  setDisplayName(id: string, displayName: string | undefined): Promise<void>;
  setDefaultAudience(id: string, snapshot: DefaultAudienceSnapshot): Promise<void>;
  setAppliedVersion(id: string, version: number): Promise<void>;
  touch(id: string, at: number): Promise<void>;
  versionOf(id: string, version: number): Promise<DeploymentVersion | null>;
  treeOf(id: string, version: number): Promise<DeployGitTreeFile[] | null>;
  filesOf(id: string, version: number, paths?: string[]): Promise<DeployGitInputFile[] | null>;
  diffVersions(id: string, fromVersion: number | undefined, toVersion: number): Promise<DeployGitDiff | null>;
  bundleOf(id: string, version: number): Promise<Uint8Array | null>;
  preparePush(id: string): Promise<string | null>;
  takePushedCommit(id: string, baseline: string | null): Promise<string | null>;
  refOf(id: string, ref: string): Promise<string | null>;
  repoUrl(id: string): Promise<string>;
}

export interface DeployStoreBackings {
  deployments?: DurableMap<Deployment>;
  git?: DeployGitStoreOptions;
}

const CURRENT_REF = "refs/heads/current";
export const deployPushGitNamespace = "pending";
const PUSH_REF = `refs/namespaces/${deployPushGitNamespace}/refs/heads/current`;
const versionRef = (version: number): string => `refs/versions/${version}`;

function normalizeBackings(backing?: DurableMap<Deployment> | DeployStoreBackings): {
  deployments: DurableMap<Deployment>;
  git: DeployGitStore;
} {
  if (!backing) return { deployments: createMemoryMap<Deployment>(), git: createDeployGitStore() };
  if ("get" in backing && "put" in backing) return { deployments: backing, git: createDeployGitStore() };
  return {
    deployments: backing.deployments ?? createMemoryMap<Deployment>(),
    git: createDeployGitStore(backing.git),
  };
}

export function createDeployStore(backing?: DurableMap<Deployment> | DeployStoreBackings): DeployStore {
  const { deployments: backingMap, git } = normalizeBackings(backing);

  async function updateDeployment(
    id: string,
    update: (deployment: Deployment) => Deployment,
  ): Promise<Deployment | null> {
    if (backingMap.update) return backingMap.update(id, update);
    const current = await backingMap.get(id);
    if (!current) return null;
    const next = update(current);
    await backingMap.put(id, next);
    return next;
  }

  async function makeVersion(
    deploymentId: string,
    version: number,
    input: VersionInput,
    parentCommit?: string,
  ): Promise<DeploymentVersion> {
    const commit = input.files
      ? await git.commit({
          deploymentId,
          version,
          files: input.files,
          ...(parentCommit ? { parent: parentCommit } : {}),
          message: `deploy v${version}`,
        })
      : undefined;
    return {
      version,
      createdAt: Date.now(),
      entrypoint: input.entrypoint,
      snapshotDir: input.snapshotDir,
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
      ...(commit ? { commit } : {}),
      ...(parentCommit ? { parentCommit } : {}),
    };
  }

  async function updateVersionRef(deploymentId: string, version: DeploymentVersion): Promise<void> {
    if (!version.commit) return;
    await git.setRef(deploymentId, versionRef(version.version), version.commit);
    await git.setRef(deploymentId, `refs/deploy-commits/${version.commit}`, version.commit);
  }

  function sameSource(a: DeploymentVersion, b: DeploymentVersion): boolean {
    return (
      a.entrypoint === b.entrypoint &&
      a.homeDir === b.homeDir &&
      JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
    );
  }

  function sameRuntime(a: DeploymentVersion, b: DeploymentVersion): boolean {
    return sameSource(a, b) && a.image === b.image;
  }

  async function resolveAppliedVersion(deploymentId: string, deployment?: Deployment): Promise<number | undefined> {
    const d = deployment ?? (await backingMap.get(deploymentId));
    if (!d || d.appliedVersion !== undefined) return d?.appliedVersion;
    const currentRef = await git.refOf(deploymentId, CURRENT_REF);
    if (!currentRef) return undefined;
    const matches = d.versions.filter((version) => version.commit === currentRef);
    if (!matches.length || !matches.every((version) => sameRuntime(version, matches[0]!))) return undefined;
    const inferred = matches.find((version) => version.version === d.currentVersion) ?? matches.at(-1)!;
    const updated = await updateDeployment(deploymentId, (current) =>
      current.appliedVersion === undefined
        ? { ...current, appliedVersion: inferred.version, currentVersion: inferred.version }
        : current,
    );
    return updated?.appliedVersion;
  }

  async function syncAppliedRef(deploymentId: string, deployment?: Deployment): Promise<void> {
    const d = deployment ?? (await backingMap.get(deploymentId));
    if (!d) return;
    const appliedVersion = d.appliedVersion ?? (await resolveAppliedVersion(deploymentId, d));
    if (appliedVersion === undefined) return;
    const version = d.versions.find((candidate) => candidate.version === appliedVersion);
    const expected = version?.commit;
    if (!expected) {
      await git.deleteRef(deploymentId, CURRENT_REF);
      return;
    }
    const actual = await git.refOf(deploymentId, CURRENT_REF);
    if (actual === expected) return;
    await git.setRef(deploymentId, CURRENT_REF, expected);
  }

  async function normalizeLegacy(deployment: Deployment): Promise<Deployment> {
    if (deployment.status === "running" && deployment.deployingVersion !== undefined) {
      deployment =
        (await updateDeployment(deployment.id, (current) => {
          if (current.status !== "running" || current.deployingVersion === undefined) return current;
          const { deployingVersion: _, ...rest } = current;
          return rest;
        })) ?? deployment;
    }
    if (
      deployment.appliedVersion !== undefined &&
      deployment.status !== "deploying" &&
      deployment.currentVersion !== deployment.appliedVersion
    ) {
      deployment =
        (await updateDeployment(deployment.id, (current) =>
          current.appliedVersion !== undefined &&
          current.status !== "deploying" &&
          current.currentVersion !== current.appliedVersion
            ? { ...current, currentVersion: current.appliedVersion }
            : current,
        )) ?? deployment;
    }
    if (deployment.appliedVersion !== undefined) return deployment;
    const appliedVersion = await resolveAppliedVersion(deployment.id, deployment);
    if (appliedVersion !== undefined) return (await backingMap.get(deployment.id)) ?? deployment;
    if (deployment.status !== "stopped") return deployment;
    return (
      (await updateDeployment(deployment.id, (current) =>
        current.appliedVersion === undefined && current.status === "stopped"
          ? { ...current, status: "failed", deployingVersion: current.currentVersion }
          : current,
      )) ?? deployment
    );
  }

  return {
    async create(input) {
      const id = randomUUID();
      const v = await makeVersion(id, 1, input);
      const d: Deployment = {
        id,
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        ...(input.name ? { name: input.name } : {}),
        ...(input.createdInScope ? { createdInScope: input.createdInScope } : {}),
        currentVersion: 1,
        status: "stopped",
        endpoint: null,
        versions: [v],
      };
      await backingMap.put(d.id, d);
      await updateVersionRef(d.id, v);
      return d;
    },
    async addVersion(id, input) {
      const d = await backingMap.get(id);
      if (!d) throw new Error(`unknown deployment: ${id}`);
      const retry =
        (d.status === "failed" || d.status === "deploying") && input.sourceHash
          ? [...d.versions]
              .reverse()
              .find((candidate) => candidate.version !== d.appliedVersion && candidate.sourceHash === input.sourceHash)
          : undefined;
      if (retry) {
        const refreshed = {
          ...retry,
          snapshotDir: input.snapshotDir,
          ...(input.homeDir ? { homeDir: input.homeDir } : {}),
        };
        await updateDeployment(id, (current) => ({
          ...current,
          status: "deploying",
          endpoint: null,
          deployingVersion: retry.version,
          versions: current.versions.map((candidate) => (candidate.version === retry.version ? refreshed : candidate)),
        }));
        return refreshed;
      }
      const version = d.versions.length + 1;
      const parentCommit = d.versions.find((x) => x.version === d.currentVersion)?.commit;
      const v = await makeVersion(id, version, input, parentCommit);
      await updateDeployment(id, (current) => {
        if (current.versions.length + 1 !== version) throw new Error(`deployment version changed: ${id}`);
        return {
          ...current,
          status: "deploying",
          endpoint: null,
          deployingVersion: version,
          versions: [...current.versions, v],
        };
      });
      await updateVersionRef(id, v);
      return v;
    },
    async addVersionFromCommit(id, commit) {
      const raw = await backingMap.get(id);
      if (!raw) throw new Error(`unknown deployment: ${id}`);
      const d = await normalizeLegacy(raw);
      const appliedVersion = await resolveAppliedVersion(id, d);
      const current = d.versions.find((x) => x.version === d.currentVersion);
      const applied = d.versions.find((x) => x.version === appliedVersion);
      if (applied?.commit === commit && d.status === "running") return null;
      const existing = d.versions
        .filter((candidate) => candidate.commit === commit && (!current || sameSource(candidate, current)))
        .at(-1);
      if (existing) {
        await updateDeployment(id, (latest) => ({
          ...latest,
          status: "deploying",
          endpoint: null,
          deployingVersion: existing.version,
        }));
        return existing;
      }
      const version = d.versions.length + 1;
      const v: DeploymentVersion = {
        version,
        createdAt: Date.now(),
        entrypoint: current?.entrypoint ?? "",
        snapshotDir: current?.snapshotDir ?? "/unused",
        ...(current?.homeDir ? { homeDir: current.homeDir } : {}),
        ...(current?.env ? { env: current.env } : {}),
        commit,
        ...(current?.commit ? { parentCommit: current.commit } : {}),
      };
      await updateDeployment(id, (latest) => {
        if (latest.versions.length + 1 !== version) throw new Error(`deployment version changed: ${id}`);
        return {
          ...latest,
          status: "deploying",
          endpoint: null,
          deployingVersion: version,
          versions: [...latest.versions, v],
        };
      });
      await updateVersionRef(id, v);
      return v;
    },
    async get(id) {
      const d = await backingMap.get(id);
      if (!d) return null;
      return normalizeLegacy(d);
    },
    async getByName(name) {
      const d = (await backingMap.all()).find((candidate) => candidate.name === name) ?? null;
      if (!d) return null;
      return normalizeLegacy(d);
    },
    async list() {
      const deployments = await backingMap.all();
      await Promise.all(deployments.map(normalizeLegacy));
      return backingMap.all();
    },
    async setCurrentVersion(id, version) {
      await updateDeployment(id, (d) => {
        if (!d.versions.some((candidate) => candidate.version === version))
          throw new Error(`no such version ${version}`);
        return { ...d, currentVersion: version };
      });
    },
    async setVersionImage(id, version, image) {
      await updateDeployment(id, (d) => {
        if (!d.versions.some((candidate) => candidate.version === version))
          throw new Error(`no such version ${version}`);
        return {
          ...d,
          versions: d.versions.map((candidate) =>
            candidate.version === version ? { ...candidate, image } : candidate,
          ),
        };
      });
    },
    async setStatus(id, status) {
      await backingMap.merge(id, { status });
    },
    async setEndpoint(id, endpoint) {
      await backingMap.merge(id, { endpoint });
    },
    async markDeploying(id, version) {
      const d = await backingMap.get(id);
      if (!d) return;
      const appliedVersion = await resolveAppliedVersion(id, d);
      await updateDeployment(id, (current) => {
        if (!current.versions.some((candidate) => candidate.version === version))
          throw new Error(`no such version ${version}`);
        return {
          ...current,
          status: current.status === "archived" ? "archived" : "deploying",
          endpoint: null,
          deployingVersion: version,
          ...(current.appliedVersion === undefined && appliedVersion !== undefined ? { appliedVersion } : {}),
        };
      });
    },
    async markFailed(id) {
      const d = await backingMap.get(id);
      if (!d) return;
      const appliedVersion = await resolveAppliedVersion(id, d);
      await updateDeployment(id, (current) => {
        return {
          ...current,
          status: "failed",
          endpoint: null,
          ...(current.appliedVersion === undefined && appliedVersion !== undefined ? { appliedVersion } : {}),
        };
      });
    },
    async markApplied(id, version, endpoint) {
      const d = await updateDeployment(id, (current) => {
        if (!current.versions.some((candidate) => candidate.version === version))
          throw new Error(`no such version ${version}`);
        const { deployingVersion: _, ...rest } = current;
        return { ...rest, endpoint, currentVersion: version, status: "running", appliedVersion: version };
      });
      if (d) await syncAppliedRef(id, d).catch((error) => swallow("deploy applied ref sync", error));
    },
    async markArchived(id) {
      await updateDeployment(id, (current) => ({ ...current, status: "archived" }));
    },
    async markStopped(id) {
      await updateDeployment(id, (current) => ({ ...current, status: "stopped" }));
    },
    async markRuntimeClean(id) {
      await updateDeployment(id, (current) => {
        const { deployingVersion: _, ...rest } = current;
        return { ...rest, endpoint: null };
      });
    },
    async setName(id, name) {
      await backingMap.merge(id, { name });
    },
    async setOwnerScope(id, ownerScopeId) {
      await backingMap.merge(id, { ownerScopeId });
    },
    async setDisplayName(id, displayName) {
      await backingMap.merge(id, { displayName });
    },
    async setDefaultAudience(id, snapshot) {
      await backingMap.merge(id, { defaultAudience: snapshot });
    },
    async setAppliedVersion(id, version) {
      const d = await updateDeployment(id, (current) => {
        if (!current.versions.some((candidate) => candidate.version === version))
          throw new Error(`no such version ${version}`);
        return { ...current, appliedVersion: version };
      });
      if (d) await syncAppliedRef(id, d);
    },
    async touch(id, at) {
      await backingMap.merge(id, { lastAccessAt: at });
    },
    async versionOf(id, version) {
      return (await backingMap.get(id))?.versions.find((v) => v.version === version) ?? null;
    },
    async treeOf(id, version) {
      const v = (await backingMap.get(id))?.versions.find((x) => x.version === version);
      return v?.commit ? git.treeOf(id, v.commit) : null;
    },
    async filesOf(id, version, paths) {
      const v = (await backingMap.get(id))?.versions.find((x) => x.version === version);
      return v?.commit ? git.filesOf(id, v.commit, paths) : null;
    },
    async diffVersions(id, fromVersion, toVersion) {
      const d = await backingMap.get(id);
      if (!d) return null;
      const from = fromVersion === undefined ? undefined : d.versions.find((v) => v.version === fromVersion)?.commit;
      const to = d.versions.find((v) => v.version === toVersion)?.commit;
      return to ? git.diff(id, from, to) : null;
    },
    async bundleOf(id, version) {
      const v = (await backingMap.get(id))?.versions.find((x) => x.version === version);
      return v?.commit ? git.bundle(id, v.commit) : null;
    },
    async preparePush(id) {
      await syncAppliedRef(id);
      const d = await backingMap.get(id);
      const applied = d?.versions.find((version) => version.version === d.appliedVersion)?.commit;
      if (applied) await git.setRef(id, PUSH_REF, applied);
      else await git.deleteRef(id, PUSH_REF);
      return applied ?? null;
    },
    async takePushedCommit(id, baseline) {
      const pushed = await git.refOf(id, PUSH_REF);
      if (pushed && pushed !== baseline) await git.setRef(id, `refs/deploy-commits/${pushed}`, pushed);
      await git.deleteRef(id, PUSH_REF);
      return pushed === baseline ? null : pushed;
    },
    async refOf(id, ref) {
      if (ref === CURRENT_REF) await syncAppliedRef(id);
      return git.refOf(id, ref);
    },
    async repoUrl(id) {
      await syncAppliedRef(id);
      return git.repoUrl(id);
    },
  };
}

export const deployCurrentGitRef = CURRENT_REF;
