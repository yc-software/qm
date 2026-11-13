import { trimTrailingSlashes } from "../util/text.ts";
import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import type { ClaimedRow } from "../tenants/claim.ts";
import { APP_TABLES, NAME_INDEX } from "./page-views.ts";
import { tenantAppHandle } from "../tenants/settings.ts";
import { appHostLabel } from "../tenants/app-handle.ts";
import {
  createDeployGitStore,
  type DeployGitInputFile,
  type DeployGitStoreOptions,
  type DeployGitTreeFile,
} from "./deploy-git-store.ts";

export interface AppVersion {
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

export function appUrlOf(
  d: { id: string; name?: string; endpoint?: DeployEndpoint | null },
  { sharedWebUrl, appsDomain }: { sharedWebUrl: string | undefined; appsDomain: string | undefined },
): string | undefined {
  const ref = d.name ?? d.id;
  const handle = tenantAppHandle();
  if (appsDomain && handle) return `https://${appHostLabel(handle, ref)}.${appsDomain.toLowerCase()}/`;
  const path = `/d/${encodeURIComponent(ref)}/`;
  return publicUrlOf(d.endpoint) ?? (sharedWebUrl ? `${trimTrailingSlashes(sharedWebUrl)}${path}` : undefined);
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

type AppStatus = "running" | "stopped" | "archived";

interface DefaultAudienceSnapshot {
  sourceScopeId: ScopeId;
  granteeScopeIds: ScopeId[];
  snapshotAt: number;
}

export interface PublishedApp {
  id: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  defaultAudience?: DefaultAudienceSnapshot;
  name?: string;
  displayName?: string;
  currentVersion: number;
  status: AppStatus;
  endpoint: DeployEndpoint | null;

  alwaysOn?: boolean;
  embedAncestors?: string[];
  connectors?: string[];
  public?: true;
  lastAccessAt?: number;
  appliedVersion?: number;
  versions: AppVersion[];
}

export interface AppDraft {
  deploymentId: string;
  commit: string;
  entrypoint: string;
  hot: boolean;
  savedBy: string;
  savedAt: number;
  publishAt?: number;
  reloads: number;
  failure?: string;
}

export function currentVersionOf(d: PublishedApp | null): AppVersion | undefined {
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
  ): Promise<PublishedApp>;
  addVersion(id: string, input: VersionInput): Promise<AppVersion>;
  addVersionFromCommit(id: string, commit: string): Promise<AppVersion | null>;
  get(id: string): Promise<PublishedApp | null>;
  getByName(name: string): Promise<PublishedApp | null>;
  list(): Promise<PublishedApp[]>;
  claimTenants(): Promise<ClaimedRow[]>;
  setCurrentVersion(id: string, version: number): Promise<void>;
  setVersionImage(id: string, version: number, image: string): Promise<void>;
  setStatus(id: string, status: AppStatus): Promise<void>;
  setEndpoint(id: string, endpoint: DeployEndpoint | null): Promise<void>;
  setName(id: string, name: string): Promise<void>;
  setOwnerScope(id: string, ownerScopeId: ScopeId): Promise<void>;
  setDisplayName(id: string, displayName: string | undefined): Promise<void>;
  setAlwaysOn(id: string, alwaysOn: boolean): Promise<void>;
  setEmbedAncestors(id: string, embedAncestors: string[]): Promise<void>;
  setConnectors(id: string, connectors: string[] | undefined): Promise<void>;
  setPublic(id: string, isPublic: boolean): Promise<void>;
  setDefaultAudience(id: string, snapshot: DefaultAudienceSnapshot): Promise<void>;
  setAppliedVersion(id: string, version: number, placedCommit?: string): Promise<void>;
  touch(id: string, at: number): Promise<void>;
  versionOf(id: string, version: number): Promise<AppVersion | null>;
  treeOf(id: string, version: number): Promise<DeployGitTreeFile[] | null>;
  commitTreeOf(id: string, commit: string): Promise<DeployGitTreeFile[]>;
  filesOf(id: string, commit: string, paths?: string[]): Promise<DeployGitInputFile[]>;
  filesIn(id: string, entries: readonly Pick<DeployGitTreeFile, "path" | "sha">[]): Promise<DeployGitInputFile[]>;
  bundleOf(id: string, commit: string): Promise<Uint8Array>;
  commitDraft(id: string, files: DeployGitInputFile[], parent: string, deletedPaths?: string[]): Promise<string>;
  keepCommit(id: string, commit: string): Promise<void>;
  draftOf(id: string): Promise<AppDraft | null>;
  putDraft(draft: AppDraft): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  drafts(): Promise<AppDraft[]>;
  claimDraftTenants(): Promise<ClaimedRow[]>;
  refOf(id: string, ref: string): Promise<string | null>;
  repoUrl(id: string): Promise<string>;
}

export interface DeployStoreBackings {
  deployments: DurableMap<PublishedApp>;
  drafts: DurableMap<AppDraft>;
  git?: DeployGitStoreOptions;
  pg: PgPool;
  touchDebounceMs?: number;
}

const CURRENT_REF = "refs/heads/current";
const versionRef = (version: number): string => `refs/versions/${version}`;
const TOUCH_DEBOUNCE_MS = 60_000;

interface DeployAccess {
  readOne(id: string): Promise<number | null>;
  readAll(): Promise<Map<string, number>>;
  write(id: string, at: number): Promise<boolean>;
  findByName?(name: string): Promise<PublishedApp | null>;
}

function createPgDeployAccess(pg: PgPool): DeployAccess {
  for (const migration of APP_TABLES) pg.registerMigration(migration);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = (async () => {
        for (const migration of APP_TABLES) await pg.migrate(migration);
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
         ON CONFLICT (tenant_id, id) DO UPDATE SET last_access_at = GREATEST(deployment_access.last_access_at, EXCLUDED.last_access_at)`,
        [id, at],
      );
      return res.rowCount > 0;
    },
    async findByName(name) {
      await ready();
      const rows = await pg.q("SELECT json FROM deployments WHERE json->>'name' = $1 ORDER BY id LIMIT 1", [name]);
      return rows.length ? (rows[0]!.json as PublishedApp) : null;
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

export function createDeployStore(backing: DeployStoreBackings): DeployStore {
  const backingMap = backing.deployments;
  const git = createDeployGitStore(backing.git);
  const touchDebounceMs = backing.touchDebounceMs ?? TOUCH_DEBOUNCE_MS;
  const access = createPgDeployAccess(backing.pg);
  const lastTouch = new Map<string, number>();

  function withAccess(d: PublishedApp, at: number | null | undefined): PublishedApp {
    return at == null ? d : { ...d, lastAccessAt: at };
  }

  async function writeNamed(name: string | undefined, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (e) {
      if (isNameConflict(e)) throw new Error(`app name taken: ${name}`, { cause: e });
      throw e;
    }
  }

  async function makeVersion(
    appId: string,
    version: number,
    input: VersionInput,
    parentCommit?: string,
  ): Promise<AppVersion> {
    const commit = input.files
      ? await git.commit({
          deploymentId: appId,
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

  async function updateVersionRef(appId: string, version: AppVersion): Promise<void> {
    if (!version.commit) return;
    await git.setRef(appId, versionRef(version.version), version.commit);
    await git.setRef(appId, `refs/deploy-commits/${version.commit}`, version.commit);
  }

  async function updateAppliedRef(appId: string, commit: string | undefined): Promise<void> {
    if (commit) await git.setRef(appId, CURRENT_REF, commit);
    else await git.deleteRef(appId, CURRENT_REF);
  }

  return {
    async create(input) {
      const id = input.id ?? randomUUID();
      const v = await makeVersion(id, 1, input);
      const d: PublishedApp = {
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
      await writeNamed(d.name, () => backingMap.put(d.id, d));
      await updateVersionRef(d.id, v);
      return d;
    },
    async addVersion(id, input) {
      const d = await backingMap.get(id);
      if (!d) throw new Error(`unknown app: ${id}`);
      const version = d.versions.length + 1;
      const parentCommit = currentVersionOf(d)?.commit;
      const v = await makeVersion(id, version, input, parentCommit);
      await backingMap.update(id, (cur) => {
        if (cur.versions.length + 1 !== version) throw new Error(`app ${id} gained a version concurrently`);
        cur.versions.push(v);
        cur.currentVersion = version;
        return cur;
      });
      await updateVersionRef(id, v);
      return v;
    },
    async addVersionFromCommit(id, commit) {
      let v: AppVersion | null = null;
      const d = await backingMap.update(id, (d) => {
        const current = currentVersionOf(d);
        if (current?.commit === commit) return d;
        const version = d.versions.length + 1;
        v = {
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
        return d;
      });
      if (!d) throw new Error(`unknown app: ${id}`);
      if (!v) return null;
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
    claimTenants() {
      return backingMap.claimTenants();
    },
    async list() {
      const [ds, accessAt] = await Promise.all([backingMap.all(), access.readAll()]);
      return ds.map((d) => withAccess(d, accessAt.get(d.id)));
    },
    async setCurrentVersion(id, version) {
      await backingMap.update(id, (d) => {
        if (!d.versions.some((x) => x.version === version)) throw new Error(`no such version ${version}`);
        d.currentVersion = version;
        return d;
      });
    },
    async setVersionImage(id, version, image) {
      await backingMap.update(id, (d) => {
        const v = d.versions.find((x) => x.version === version);
        if (!v) throw new Error(`no such version ${version}`);
        v.image = image;
        return d;
      });
    },
    async setStatus(id, status) {
      await backingMap.merge(id, { status });
    },
    async setEndpoint(id, endpoint) {
      await backingMap.merge(id, { endpoint });
    },
    async setName(id, name) {
      await writeNamed(name, () => backingMap.merge(id, { name }));
    },
    async setOwnerScope(id, ownerScopeId) {
      await backingMap.merge(id, { ownerScopeId });
    },
    async setDisplayName(id, displayName) {
      await backingMap.merge(id, { displayName: displayName || undefined });
    },
    async setAlwaysOn(id, alwaysOn) {
      await backingMap.merge(id, { alwaysOn } as Partial<PublishedApp>);
    },
    async setEmbedAncestors(id, embedAncestors) {
      await backingMap.merge(id, { embedAncestors } as Partial<PublishedApp>);
    },
    async setConnectors(id, connectors) {
      await backingMap.merge(id, { connectors });
    },
    async setPublic(id, isPublic) {
      await backingMap.merge(id, { public: isPublic ? true : undefined });
    },
    async setDefaultAudience(id, snapshot) {
      await backingMap.merge(id, { defaultAudience: snapshot });
    },
    async setAppliedVersion(id, version, placedCommit) {
      let commit: string | undefined;
      const d = await backingMap.update(id, (d) => {
        const v = d.versions.find((x) => x.version === version);
        if (!v) throw new Error(`no such version ${version}`);
        commit = v.commit;
        d.appliedVersion = version;
        return d;
      });
      if (d) await updateAppliedRef(id, placedCommit ?? commit);
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
    commitTreeOf: (id, commit) => git.treeOf(id, commit),
    filesOf: (id, commit, paths) => git.filesOf(id, commit, paths),
    filesIn: (id, entries) => git.filesIn(id, entries),
    bundleOf: (id, commit) => git.bundle(id, commit),
    keepCommit: (id, commit) => git.setRef(id, `refs/deploy-commits/${commit}`, commit),
    commitDraft: (id, files, parent, deletedPaths) =>
      git.commit({
        deploymentId: id,
        version: 0,
        files,
        ...(deletedPaths ? { deletedPaths } : {}),
        parent,
        message: "live edit",
        ref: CURRENT_REF,
      }),
    draftOf: (id) => backing.drafts.get(id),
    putDraft: (draft) => backing.drafts.put(draft.deploymentId, draft),
    deleteDraft: (id) => backing.drafts.delete(id),
    drafts: () => backing.drafts.all(),
    claimDraftTenants: () => backing.drafts.claimTenants(),
    refOf: (id, ref) => git.refOf(id, ref),
    repoUrl: (id) => git.repoUrl(id),
  };
}

export const deployCurrentGitRef = CURRENT_REF;
