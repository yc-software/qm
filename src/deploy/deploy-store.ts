import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
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

type DeploymentStatus = "running" | "stopped" | "archived";

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
  versions: DeploymentVersion[];
}

interface VersionInput {
  entrypoint: string;
  snapshotDir: string;
  homeDir?: string;
  env?: Record<string, string>;
  files?: DeployGitInputFile[];
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
  refOf(id: string, ref: string): Promise<string | null>;
  repoUrl(id: string): Promise<string>;
}

export interface DeployStoreBackings {
  deployments?: DurableMap<Deployment>;
  git?: DeployGitStoreOptions;
}

const CURRENT_REF = "refs/heads/current";
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
      ...(commit ? { commit } : {}),
      ...(parentCommit ? { parentCommit } : {}),
    };
  }

  async function updateVersionRef(deploymentId: string, version: DeploymentVersion): Promise<void> {
    if (!version.commit) return;
    await git.setRef(deploymentId, versionRef(version.version), version.commit);
    await git.setRef(deploymentId, `refs/deploy-commits/${version.commit}`, version.commit);
  }

  async function updateAppliedRef(deploymentId: string, version: DeploymentVersion): Promise<void> {
    if (version.commit) await git.setRef(deploymentId, CURRENT_REF, version.commit);
    else await git.deleteRef(deploymentId, CURRENT_REF);
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
      const version = d.versions.length + 1;
      const parentCommit = d.versions.find((x) => x.version === d.currentVersion)?.commit;
      const v = await makeVersion(id, version, input, parentCommit);
      d.versions.push(v);
      d.currentVersion = version;
      await backingMap.put(id, d);
      await updateVersionRef(id, v);
      return v;
    },
    async addVersionFromCommit(id, commit) {
      const d = await backingMap.get(id);
      if (!d) throw new Error(`unknown deployment: ${id}`);
      const current = d.versions.find((x) => x.version === d.currentVersion);
      if (current?.commit === commit) return null;
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
      d.versions.push(v);
      d.currentVersion = version;
      await backingMap.put(id, d);
      await updateVersionRef(id, v);
      return v;
    },
    get: (id) => backingMap.get(id),
    getByName: async (name) => (await backingMap.all()).find((d) => d.name === name) ?? null,
    list: () => backingMap.all(),
    async setCurrentVersion(id, version) {
      const d = await backingMap.get(id);
      if (!d) return;
      const v = d.versions.find((x) => x.version === version);
      if (!v) throw new Error(`no such version ${version}`);
      d.currentVersion = version;
      await backingMap.put(id, d);
    },
    async setVersionImage(id, version, image) {
      const d = await backingMap.get(id);
      if (!d) return;
      const v = d.versions.find((x) => x.version === version);
      if (!v) throw new Error(`no such version ${version}`);
      v.image = image;
      await backingMap.put(id, d);
    },
    async setStatus(id, status) {
      const d = await backingMap.get(id);
      if (d) {
        d.status = status;
        await backingMap.put(id, d);
      }
    },
    async setEndpoint(id, endpoint) {
      const d = await backingMap.get(id);
      if (d) {
        d.endpoint = endpoint;
        await backingMap.put(id, d);
      }
    },
    async setName(id, name) {
      const d = await backingMap.get(id);
      if (d) {
        d.name = name;
        await backingMap.put(id, d);
      }
    },
    async setOwnerScope(id, ownerScopeId) {
      const d = await backingMap.get(id);
      if (d) {
        d.ownerScopeId = ownerScopeId;
        await backingMap.put(id, d);
      }
    },
    async setDisplayName(id, displayName) {
      const d = await backingMap.get(id);
      if (d) {
        if (displayName) d.displayName = displayName;
        else delete d.displayName;
        await backingMap.put(id, d);
      }
    },
    async setDefaultAudience(id, snapshot) {
      const d = await backingMap.get(id);
      if (d) {
        d.defaultAudience = snapshot;
        await backingMap.put(id, d);
      }
    },
    async setAppliedVersion(id, version) {
      const d = await backingMap.get(id);
      if (!d) return;
      const v = d.versions.find((x) => x.version === version);
      if (!v) throw new Error(`no such version ${version}`);
      d.appliedVersion = version;
      await backingMap.put(id, d);
      await updateAppliedRef(id, v);
    },
    async touch(id, at) {
      const d = await backingMap.get(id);
      if (d) {
        d.lastAccessAt = at;
        await backingMap.put(id, d);
      }
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
    refOf: (id, ref) => git.refOf(id, ref),
    repoUrl: (id) => git.repoUrl(id),
  };
}

export const deployCurrentGitRef = CURRENT_REF;
