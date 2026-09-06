import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
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

  alwaysOn?: boolean;
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
    input: {
      ownerScopeId: ScopeId;
      createdBy: string;
      name?: string;
      createdInScope?: ScopeId;
      alwaysOn?: boolean;
    } & VersionInput,
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
  setAlwaysOn(id: string, alwaysOn: boolean): Promise<void>;
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
  pg?: PgPool;
  touchDebounceMs?: number;
}

const CURRENT_REF = "refs/heads/current";
const versionRef = (version: number): string => `refs/versions/${version}`;
const NAME_INDEX = "deployments_name_unique";
const TOUCH_DEBOUNCE_MS = 60_000;

function normalizeBackings(backing?: DurableMap<Deployment> | DeployStoreBackings): {
  deployments: DurableMap<Deployment>;
  git: DeployGitStore;
  pg?: PgPool;
  touchDebounceMs: number;
} {
  if (!backing)
    return {
      deployments: createMemoryMap<Deployment>(),
      git: createDeployGitStore(),
      touchDebounceMs: TOUCH_DEBOUNCE_MS,
    };
  if ("get" in backing && "put" in backing)
    return { deployments: backing, git: createDeployGitStore(), touchDebounceMs: TOUCH_DEBOUNCE_MS };
  return {
    deployments: backing.deployments ?? createMemoryMap<Deployment>(),
    git: createDeployGitStore(backing.git),
    ...(backing.pg ? { pg: backing.pg } : {}),
    touchDebounceMs: backing.touchDebounceMs ?? TOUCH_DEBOUNCE_MS,
  };
}

interface DeployAccess {
  readOne(id: string): Promise<number | null>;
  readAll(): Promise<Map<string, number>>;
  write(id: string, at: number): Promise<boolean>;
  findByName?(name: string): Promise<Deployment | null>;
}

function createMemoryDeployAccess(deployments: DurableMap<Deployment>): DeployAccess {
  const accessAt = new Map<string, number>();
  return {
    async readOne(id) {
      return accessAt.get(id) ?? null;
    },
    async readAll() {
      return new Map(accessAt);
    },
    async write(id, at) {
      if (!(await deployments.get(id))) return false;
      accessAt.set(id, Math.max(accessAt.get(id) ?? 0, at));
      return true;
    },
  };
}

function createPgDeployAccess(pg: PgPool): DeployAccess {
  const migration = {
    id: "deploy/access/0001",
    statements: [
      "CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      `CREATE TABLE IF NOT EXISTS deployment_access (
        id TEXT PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
        last_access_at BIGINT NOT NULL
      )`,
    ],
  };
  pg.registerMigration(migration);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = (async () => {
        await pg.migrate(migration);
        await pg
          .q(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${NAME_INDEX}
             ON deployments ((json->>'name')) WHERE json->>'name' IS NOT NULL`,
          )
          .catch((e) =>
            swallow(
              "deploy-store: could not create unique name index on deployments (concurrent boot, or duplicate names)",
              e,
            ),
          );
      })().catch((e) => {
        readyP = null;
        throw e;
      });
    }
    return readyP;
  }
  return {
    async readOne(id) {
      await ready();
      const rows = await pg.q("SELECT last_access_at FROM deployment_access WHERE id = $1", [id]);
      return rows.length ? Number(rows[0]!.last_access_at) : null;
    },
    async readAll() {
      await ready();
      const rows = await pg.q("SELECT id, last_access_at FROM deployment_access");
      return new Map(rows.map((row) => [row.id as string, Number(row.last_access_at)]));
    },
    async write(id, at) {
      await ready();
      const res = await pg.query(
        `INSERT INTO deployment_access (id, last_access_at)
         SELECT d.id, $2::bigint FROM deployments d WHERE d.id = $1
         ON CONFLICT (id) DO UPDATE SET last_access_at = GREATEST(deployment_access.last_access_at, EXCLUDED.last_access_at)`,
        [id, at],
      );
      return res.rowCount > 0;
    },
    async findByName(name) {
      await ready();
      const rows = await pg.q("SELECT json FROM deployments WHERE json->>'name' = $1 ORDER BY id LIMIT 1", [name]);
      return rows.length ? (rows[0]!.json as Deployment) : null;
    },
  };
}

export function deployTouchDebounceMs(reapTtlMs?: number): number {
  if (!reapTtlMs || reapTtlMs <= 0) return TOUCH_DEBOUNCE_MS;
  return Math.min(TOUCH_DEBOUNCE_MS, Math.floor(reapTtlMs / 4));
}

function isNameConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === "23505" && err?.constraint === NAME_INDEX;
}

export function createDeployStore(backing?: DurableMap<Deployment> | DeployStoreBackings): DeployStore {
  const { deployments: backingMap, git, pg, touchDebounceMs } = normalizeBackings(backing);
  const access = pg ? createPgDeployAccess(pg) : createMemoryDeployAccess(backingMap);
  const lastTouch = new Map<string, number>();

  function withAccess(d: Deployment, at: number | null | undefined): Deployment {
    return at == null ? d : { ...d, lastAccessAt: at };
  }

  async function putNamed(d: Deployment): Promise<void> {
    try {
      await backingMap.put(d.id, d);
    } catch (e) {
      if (isNameConflict(e)) throw new Error(`deployment name taken: ${d.name}`, { cause: e });
      throw e;
    }
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
        ...(input.alwaysOn ? { alwaysOn: true } : {}),
        currentVersion: 1,
        status: "stopped",
        endpoint: null,
        versions: [v],
      };
      await putNamed(d);
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
    async get(id) {
      const d = await backingMap.get(id);
      return d ? withAccess(d, await access.readOne(id)) : null;
    },
    async getByName(name) {
      const d = access.findByName
        ? await access.findByName(name)
        : ((await backingMap.all()).find((x) => x.name === name) ?? null);
      return d ? withAccess(d, await access.readOne(d.id)) : null;
    },
    async list() {
      const [ds, accessAt] = await Promise.all([backingMap.all(), access.readAll()]);
      return ds.map((d) => withAccess(d, accessAt.get(d.id)));
    },
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
        await putNamed(d);
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
    async setAlwaysOn(id, alwaysOn) {
      await backingMap.merge(id, { alwaysOn } as Partial<Deployment>);
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
      const prev = lastTouch.get(id);
      if (prev !== undefined && at - prev < touchDebounceMs) return;
      if (await access.write(id, at)) lastTouch.set(id, at);
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
