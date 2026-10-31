import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { tableConversion, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { tenantMap } from "../tenants/context.ts";
import {
  createDeployGitStore,
  type DeployGitDiff,
  type DeployGitInputFile,
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
  socksProxyPort?: number;
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
  embedAncestors?: string[];
  connectors?: string[];
  public?: true;
  lastAccessAt?: number;
  appliedVersion?: number;
  versions: DeploymentVersion[];
}

export function currentVersionOf(d: Deployment | null): DeploymentVersion | undefined {
  return d?.versions.find((v) => v.version === d.currentVersion);
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
      id?: string;
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
  setEmbedAncestors(id: string, embedAncestors: string[]): Promise<void>;
  setConnectors(id: string, connectors: string[] | undefined): Promise<void>;
  setPublic(id: string, isPublic: boolean): Promise<void>;
  setDefaultAudience(id: string, snapshot: DefaultAudienceSnapshot): Promise<void>;
  setAppliedVersion(id: string, version: number): Promise<void>;
  touch(id: string, at: number): Promise<void>;
  versionOf(id: string, version: number): Promise<DeploymentVersion | null>;
  treeOf(id: string, version: number): Promise<DeployGitTreeFile[] | null>;
  commitTreeOf(id: string, commit: string): Promise<DeployGitTreeFile[]>;
  filesOf(id: string, version: number, paths?: string[]): Promise<DeployGitInputFile[] | null>;
  diffVersions(id: string, fromVersion: number | undefined, toVersion: number): Promise<DeployGitDiff | null>;
  bundleOf(id: string, version: number): Promise<Uint8Array | null>;
  refOf(id: string, ref: string): Promise<string | null>;
  repoUrl(id: string): Promise<string>;
}

export interface DeploymentRows {
  get(id: string): Promise<Deployment | null>;
  put(id: string, deployment: Deployment): Promise<void>;
  merge(id: string, patch: Partial<Deployment>): Promise<unknown>;
  list(): Promise<Deployment[]>;
  byName(name: string): Promise<Deployment | null>;
  touch(id: string, at: number): Promise<boolean>;
}

export interface DeployStoreBackings {
  deployments?: DeploymentRows;
  git?: DeployGitStoreOptions;
  touchDebounceMs?: number;
}

const CURRENT_REF = "refs/heads/current";
const versionRef = (version: number): string => `refs/versions/${version}`;
const NAME_INDEX = "deployments_name_key";
const TOUCH_DEBOUNCE_MS = 60_000;

const DEPLOYMENTS: TableSpec<Deployment, "id"> = {
  table: "deployments",
  fieldKey: "id",
  required: ["ownerScopeId", "createdBy", "currentVersion", "status", "versions"],
  preserve: ["lastAccessAt"],
  indexes: [
    `CREATE UNIQUE INDEX ${NAME_INDEX} ON deployments (name)`,
    `CREATE INDEX deployments_resource_search_gin ON deployments USING GIN
       (to_tsvector('simple', coalesce(display_name, name, '') || ' ' || coalesce(name, '')))`,
  ],
  columns: {
    ownerScopeId: "text",
    createdBy: "text",
    createdInScope: "text",
    defaultAudience: "jsonb",
    name: "text",
    displayName: "text",
    currentVersion: "bigint",
    status: "text",
    endpoint: "jsonb",
    alwaysOn: "boolean",
    embedAncestors: "text[]",
    connectors: "text[]",
    public: "boolean",
    lastAccessAt: "bigint",
    appliedVersion: "bigint",
    versions: "jsonb",
  },
};

const DEPLOYMENT_MIGRATIONS = [
  {
    id: "tenancy/deployment_prep/0001",
    statements: [
      `ALTER TABLE IF EXISTS app_page_views DROP CONSTRAINT IF EXISTS app_page_views_deployment_id_fkey`,
      `DO $prep$ BEGIN
         IF to_regclass('deployment_access') IS NOT NULL THEN
           UPDATE deployments d SET json = d.json || jsonb_build_object('lastAccessAt', a.last_access_at)
             FROM deployment_access a WHERE a.id = d.id;
           DROP TABLE deployment_access;
         END IF;
         IF to_regclass('deployments') IS NOT NULL THEN
           UPDATE deployments d SET json = d.json - 'name'
            WHERE EXISTS (SELECT 1 FROM deployments o WHERE o.json->>'name' = d.json->>'name' AND o.id < d.id);
         END IF;
       END $prep$`,
    ],
  },
  tableConversion(DEPLOYMENTS),
];

const withEndpoint = (d: Deployment): Deployment => ({ ...d, endpoint: d.endpoint ?? null });

export function createPostgresDeploymentRows(databaseUrl: string): DeploymentRows {
  const table = typedTable(databaseUrl, DEPLOYMENTS, DEPLOYMENT_MIGRATIONS[1]!, [DEPLOYMENT_MIGRATIONS[0]!]);
  const one = async (where: string, params: unknown[]) =>
    (await table.db.q(`${table.select} WHERE ${table.scoped(where)}`, params)).map(table.row).map(withEndpoint)[0] ??
    null;
  return {
    get: (id) => one("id = $1", [id]),
    put: table.put,
    merge: table.merge,
    list: async () =>
      (await table.db.q(`${table.select} WHERE ${table.scoped("true")} ORDER BY id`)).map(table.row).map(withEndpoint),
    byName: (name) => one("name = $1", [name]),
    touch: async (id, at) =>
      (
        await table.db.query(
          `UPDATE deployments SET last_access_at = GREATEST(last_access_at, $2) WHERE ${table.scoped("id = $1")}`,
          [id, at],
        )
      ).rowCount > 0,
  };
}

export function createMemoryDeploymentRows(): DeploymentRows {
  const tenantRows = tenantMap<Deployment>();
  const copy = (d: Deployment | undefined) => (d ? structuredClone(d) : null);
  return {
    get: async (id) => copy(tenantRows().get(id)),
    async put(id, d) {
      const { lastAccessAt, ...rest } = structuredClone(d);
      const kept = tenantRows().has(id) ? tenantRows().get(id)!.lastAccessAt : lastAccessAt;
      tenantRows().set(id, kept === undefined ? rest : { ...rest, lastAccessAt: kept });
    },
    async merge(id, patch) {
      const current = tenantRows().get(id);
      if (!current) return;
      for (const [field, value] of Object.entries(patch) as Array<[keyof Deployment, unknown]>)
        if (value === undefined) delete current[field];
        else Object.assign(current, { [field]: structuredClone(value) });
    },
    list: async () =>
      [...tenantRows().values()].sort((a, b) => a.id.localeCompare(b.id)).map((d) => structuredClone(d)),
    byName: async (name) => copy([...tenantRows().values()].find((d) => d.name === name)),
    async touch(id, at) {
      const current = tenantRows().get(id);
      if (!current) return false;
      current.lastAccessAt = Math.max(current.lastAccessAt ?? 0, at);
      return true;
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

export function createDeployStore(backing: DeployStoreBackings = {}): DeployStore {
  const backingMap = backing.deployments ?? createMemoryDeploymentRows();
  const git = createDeployGitStore(backing.git);
  const touchDebounceMs = backing.touchDebounceMs ?? TOUCH_DEBOUNCE_MS;
  const lastTouch = new Map<string, number>();

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
      const id = input.id ?? randomUUID();
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
      const parentCommit = currentVersionOf(d)?.commit;
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
      const current = currentVersionOf(d);
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
    getByName: (name) => backingMap.byName(name),
    list: () => backingMap.list(),
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
    async setEmbedAncestors(id, embedAncestors) {
      await backingMap.merge(id, { embedAncestors } as Partial<Deployment>);
    },
    async setConnectors(id, connectors) {
      await backingMap.merge(id, { connectors });
    },
    async setPublic(id, isPublic) {
      await backingMap.merge(id, { public: isPublic ? true : undefined });
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
      if (await backingMap.touch(id, at)) lastTouch.set(id, at);
    },
    async versionOf(id, version) {
      return (await backingMap.get(id))?.versions.find((v) => v.version === version) ?? null;
    },
    async treeOf(id, version) {
      const v = (await backingMap.get(id))?.versions.find((x) => x.version === version);
      return v?.commit ? git.treeOf(id, v.commit) : null;
    },
    commitTreeOf: (id, commit) => git.treeOf(id, commit),
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
