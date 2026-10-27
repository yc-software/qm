import { createHash } from "node:crypto";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import {
  safeSkillFilePath,
  type Skill,
  type SkillFile,
  type SkillManifest,
  type SkillStore,
} from "../skills/skill-store.ts";
import { foreignSkillCollision, parseSeedSkill, sameManifest, upsertSeedSkill } from "../skills/seed.ts";
import {
  bundleFilePaths,
  detectPathCollisions,
  persistedSkillRecordPaths,
  SKILL_MATERIALIZATION_LOCK,
  skillRecordPaths,
} from "../skills/skill-collision.ts";
import type { SkillBundleStore } from "../skills/skill-bundle-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import { hasLoneSurrogate } from "../util/text.ts";
import { perTenant, tenant } from "../tenant.ts";
import { parseToolDescriptor, type ToolDescriptor } from "./deployment-layer.ts";
import {
  declaredInstallFiles,
  replaceDeploymentLayer,
  resolvedDeploymentLayer,
  type DeploymentLayerRuntime,
  type LayerInstallFile,
} from "./load-layer.ts";

interface DeploymentLayerFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface DeploymentLayerBundle {
  contract: 1;
  tools: DeploymentLayerFile[];
  skills: DeploymentLayerFile[];
}

export interface StoredDeploymentLayer {
  contentHash: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
  bundle: DeploymentLayerBundle;
  resolved: Omit<DeploymentLayerRuntime, "dir">;
  pendingAudits?: DeploymentLayerAuditRevision[];
}

interface DeploymentLayerAuditRevision {
  contentHash: string;
  version: number;
  updatedAt: number;
  updatedBy: string;
}

export interface DeploymentLayerStore {
  hydrate(): Promise<StoredDeploymentLayer | null>;
  get(): Promise<StoredDeploymentLayer | null>;
  put(bundle: DeploymentLayerBundle, updatedBy: string): Promise<StoredDeploymentLayer>;
  isApplied(contentHash: string): Promise<boolean>;
  live(): {
    source: "durable" | "filesystem" | "none";
    contentHash: string | null;
    resolved: Omit<DeploymentLayerRuntime, "dir"> | null;
  };
}

export class DeploymentLayerValidationError extends Error {}
export class DeploymentLayerPersistedError extends Error {
  readonly record: StoredDeploymentLayer;

  constructor(message: string, record: StoredDeploymentLayer, options?: ErrorOptions) {
    super(message, options);
    this.record = record;
  }
}
class DeploymentLayerMutationError extends Error {}

const CURRENT = "current";

const DEPLOYMENT_LAYER: TableSpec = {
  table: "deployment_layer",
  key: "id",
  columns: cols(`contentHash text!, version bigint!, updatedAt bigint!, updatedBy text!, bundle jsonb!,
    resolved jsonb!, pendingAudits jsonb`),
};

const DEPLOYMENT_LAYER_MIGRATION = mapToTableMigration("deployment/layer/0001-typed", DEPLOYMENT_LAYER);

export const LAYER_CREATED_BY = "system:deployment-layer";
export const LAYER_REVIEWER = "system:deployment-layer-reviewer";
const pathOrder = (a: DeploymentLayerFile, b: DeploymentLayerFile): number => {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
};

function normalizedBundle(input: DeploymentLayerBundle): DeploymentLayerBundle {
  if (input.contract !== 1 || !Array.isArray(input.tools) || !Array.isArray(input.skills)) {
    throw new Error("deployment layer requires contract: 1, tools[], and skills[]");
  }
  const normalize = (kind: "tools" | "skills", files: DeploymentLayerFile[]): DeploymentLayerFile[] => {
    const seen = new Set<string>();
    return files
      .map((file) => {
        if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
          throw new Error(`deployment layer ${kind} entries require string path and content`);
        }
        if (file.path.includes("\u0000") || file.content.includes("\u0000")) {
          throw new Error(
            `deployment layer ${kind} entry contains a NUL character, which the store cannot persist: ${file.path}`,
          );
        }
        if (hasLoneSurrogate(file.path) || hasLoneSurrogate(file.content)) {
          throw new Error(
            `deployment layer ${kind} entry contains an unpaired Unicode surrogate, which the store cannot persist: ${file.path}`,
          );
        }
        const path = safeSkillFilePath(file.path);
        if (!path.startsWith(`${kind}/`))
          throw new Error(`deployment layer ${kind} path must start with ${kind}/: ${path}`);
        if (seen.has(path)) throw new Error(`duplicate deployment layer path: ${path}`);
        seen.add(path);
        return { path, content: file.content, ...(file.executable === true ? { executable: true } : {}) };
      })
      .sort(pathOrder);
  };
  return { contract: 1, tools: normalize("tools", input.tools), skills: normalize("skills", input.skills) };
}

function toolDescriptors(files: DeploymentLayerFile[]): { tools: ToolDescriptor[]; installFiles: LayerInstallFile[] } {
  const byDir = new Map<string, DeploymentLayerFile[]>();
  for (const file of files) {
    const match = file.path.match(/^tools\/([^/]+)\/([^/]+)$/);
    if (!match) throw new Error(`deployment layer tool path must be tools/<id>/tool.json: ${file.path}`);
    const list = byDir.get(match[1]!) ?? [];
    list.push(file);
    byDir.set(match[1]!, list);
  }
  const tools: ToolDescriptor[] = [];
  const contents = new Map<string, Map<string, string>>();
  const ids = new Set<string>();
  for (const [dir, entries] of byDir) {
    const descriptor = entries.find((file) => file.path === `tools/${dir}/tool.json`);
    if (!descriptor) throw new Error(`deployment layer tool path must be tools/<id>/tool.json: ${entries[0]!.path}`);
    const tool = parseToolDescriptor(descriptor.content, descriptor.path);
    if (ids.has(tool.id)) throw new Error(`duplicate deployment tool id: ${tool.id}`);
    ids.add(tool.id);
    const declared = new Map((tool.install?.files ?? []).map((file) => [file.from, file]));
    const present = new Map<string, string>();
    for (const file of entries) {
      if (file === descriptor) continue;
      const name = file.path.slice(`tools/${dir}/`.length);
      if (!declared.has(name)) {
        throw new Error(`deployment layer tool path must be tools/<id>/tool.json: ${file.path}`);
      }
      present.set(name, file.content);
    }
    for (const name of declared.keys()) {
      if (!present.has(name))
        throw new Error(
          `deployment layer tool ${tool.id} declares install file ${name} but the bundle does not carry tools/${dir}/${name}`,
        );
    }
    tools.push(tool);
    contents.set(tool.id, present);
  }
  const installFiles = declaredInstallFiles(tools, (tool, file) => contents.get(tool.id)!.get(file.from)!);
  return { tools, installFiles };
}

function skillManifests(files: DeploymentLayerFile[]): SkillManifest[] {
  const byDir = new Map<string, DeploymentLayerFile[]>();
  for (const file of files) {
    const match = file.path.match(/^skills\/([^/]+)\/(.+)$/);
    if (!match) throw new Error(`deployment layer skill path must be skills/<id>/<file>: ${file.path}`);
    const dir = match[1]!;
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const manifests: SkillManifest[] = [];
  const names = new Set<string>();
  for (const [dir, entries] of [...byDir].sort(([a], [b]) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  })) {
    const root = entries.find((file) => file.path === `skills/${dir}/SKILL.md`);
    if (!root) throw new Error(`deployment layer skill ${dir} has no SKILL.md`);
    const manifest = parseSeedSkill(root.content);
    if (names.has(manifest.name)) throw new Error(`duplicate deployment skill name: ${manifest.name}`);
    names.add(manifest.name);
    const assets: SkillFile[] = entries
      .filter((file) => file !== root)
      .map((file) => ({
        path: safeSkillFilePath(file.path.slice(`skills/${dir}/`.length)),
        content: file.content,
        ...(file.executable === true ? { executable: true } : {}),
      }));
    manifest.files = assets;
    manifests.push(manifest);
  }
  const claimed = new Map<string, string>();
  for (const manifest of manifests) {
    const paths = skillRecordPaths(manifest.name, manifest.files);
    const collisions = detectPathCollisions(paths, claimed);
    if (collisions.length) {
      throw new Error(
        `deployment skill "${manifest.name}" materializes over ${collisions[0]!.path}, already claimed by ${collisions[0]!.owner}`,
      );
    }
    for (const path of paths) claimed.set(path, `deployment skill "${manifest.name}"`);
  }
  return manifests;
}

function contentHash(bundle: DeploymentLayerBundle): string {
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

function publicResolved(runtime: DeploymentLayerRuntime): Omit<DeploymentLayerRuntime, "dir"> {
  const { dir: _dir, ...resolved } = runtime;
  return resolved;
}

function pendingAuditRevisions(record: StoredDeploymentLayer): DeploymentLayerAuditRevision[] {
  return (
    record.pendingAudits ?? [
      {
        contentHash: record.contentHash,
        version: record.version,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      },
    ]
  );
}

function validateBundle(
  input: DeploymentLayerBundle,
  dir: string,
): {
  bundle: DeploymentLayerBundle;
  manifests: SkillManifest[];
  runtime: DeploymentLayerRuntime;
} {
  const bundle = normalizedBundle(input);
  const { tools, installFiles } = toolDescriptors(bundle.tools);
  const manifests = skillManifests(bundle.skills);
  return { bundle, manifests, runtime: resolvedDeploymentLayer(dir, tools, installFiles) };
}

interface DeploymentLayerStoreOptions {
  databaseUrl: string;
  runtime: DeploymentLayerRuntime;
  skills: SkillStore;
  skillBundles?: SkillBundleStore;
  seedFallback?: () => Promise<unknown>;
  now?: () => number;
  retryDelaysMs?: readonly number[];
  advisoryLock: AdvisoryLock;
  auditPersisted?: (record: StoredDeploymentLayer) => Promise<void>;
}

function retryingWith(retryDelaysMs: readonly number[]) {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= retryDelaysMs.length) throw error;
        console.error(`[deployment-layer] attempt ${attempt + 1} failed, retrying: ${errMessage(error)}`);
        await sleep(retryDelaysMs[attempt]!);
      }
    }
  };
}

type Retrying = ReturnType<typeof retryingWith>;

function layerProjection(opts: DeploymentLayerStoreOptions, retrying: Retrying) {
  const layerSkills = (all: Skill[]): Skill[] =>
    all.filter((skill) => skill.scopeId === tenant().orgScope && skill.createdBy === LAYER_CREATED_BY);

  const activeBundleClaims = async (all: Skill[]): Promise<Map<string, string>> => {
    const claimed = new Map<string, string>();
    if (!opts.skillBundles) return claimed;
    const active = new Set(
      all.flatMap((skill) => (skill.status === "published" && skill.pack?.packId ? [skill.pack.packId] : [])),
    );
    const bundles = (await opts.skillBundles.list())
      .filter((bundle) => active.has(bundle.packId))
      .sort((a, b) => {
        if (a.packId < b.packId) return -1;
        if (a.packId > b.packId) return 1;
        return 0;
      });
    for (const bundle of bundles) {
      for (const path of bundleFilePaths(bundle.files).sort()) claimed.set(path, `pack:${bundle.packId}`);
    }
    return claimed;
  };

  const assertNoBundleCollisions = async (manifests: SkillManifest[], all: Skill[]): Promise<void> => {
    const claimed = await activeBundleClaims(all);
    for (const manifest of manifests) {
      const collision = detectPathCollisions(skillRecordPaths(manifest.name, manifest.files), claimed)[0];
      if (collision) {
        throw new Error(
          `deployment layer skill "${manifest.name}" materializes over ${collision.path}, already claimed by ${collision.owner}`,
        );
      }
    }
  };

  const projectionMatches = async (
    record: StoredDeploymentLayer,
    validated?: ReturnType<typeof validateBundle>,
  ): Promise<boolean> => {
    if (opts.runtime.dir !== `durable:${record.contentHash}`) return false;
    const next = validated ?? validateBundle(record.bundle, `durable:${record.contentHash}`);
    if (JSON.stringify(publicResolved(opts.runtime)) !== JSON.stringify(publicResolved(next.runtime))) return false;
    const current = layerSkills(await opts.skills.list());
    const wanted = new Set(next.manifests.map((manifest) => manifest.name));
    if (current.some((skill) => skill.status !== "archived" && !wanted.has(skill.manifest.name))) return false;
    return next.manifests.every((manifest) => {
      const matches = current.filter((skill) => skill.status !== "archived" && skill.manifest.name === manifest.name);
      return matches.length === 1 && matches[0]!.status === "published" && sameManifest(matches[0]!.manifest, manifest);
    });
  };

  const restoreProjection = async (snapshot: Skill[]): Promise<void> => {
    const before = new Set(snapshot.map((skill) => skill.id));
    for (const skill of layerSkills(await opts.skills.list())) {
      if (!before.has(skill.id)) await opts.skills.delete(skill.id);
    }
    for (const skill of snapshot) await opts.skills.restore(skill);
  };

  const project = async (manifests: SkillManifest[], nextRuntime: DeploymentLayerRuntime): Promise<void> => {
    const all = await opts.skills.list();
    const snapshot = layerSkills(all).map((skill) => structuredClone(skill));
    const wanted = new Set<string>();
    try {
      await assertNoBundleCollisions(manifests, all);
      for (const manifest of manifests) {
        wanted.add(manifest.name);
        const outcome = await upsertSeedSkill(opts.skills, {
          scopeId: tenant().orgScope,
          manifest,
          createdBy: LAYER_CREATED_BY,
          reviewer: LAYER_REVIEWER,
        });
        if (outcome === "foreign") {
          throw new Error(`deployment layer skill "${manifest.name}" collides with an existing non-layer skill`);
        }
      }
      const projected = layerSkills(await opts.skills.list());
      for (const manifest of manifests) {
        const desired = projected.find(
          (skill) =>
            skill.status === "published" &&
            skill.manifest.name === manifest.name &&
            sameManifest(skill.manifest, manifest),
        );
        if (!desired) throw new Error(`deployment layer skill "${manifest.name}" did not publish`);
        for (const duplicate of projected) {
          if (
            duplicate.id !== desired.id &&
            duplicate.status !== "archived" &&
            duplicate.manifest.name === manifest.name
          ) {
            await opts.skills.archive(duplicate.id);
          }
        }
      }
      for (const skill of projected) {
        if (
          skill.scopeId === tenant().orgScope &&
          skill.createdBy === LAYER_CREATED_BY &&
          !wanted.has(skill.manifest.name)
        ) {
          await opts.skills.archive(skill.id);
        }
      }
      replaceDeploymentLayer(opts.runtime, nextRuntime);
    } catch (error) {
      try {
        await retrying(() => restoreProjection(snapshot));
      } catch (rollbackError) {
        throw new DeploymentLayerMutationError(
          `${errMessage(error)}; deployment skill rollback also failed: ${errMessage(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw new DeploymentLayerMutationError(errMessage(error), { cause: error });
    }
  };

  return { activeBundleClaims, projectionMatches, project };
}

async function assertPutAllowed(
  opts: DeploymentLayerStoreOptions,
  manifests: SkillManifest[],
  activeBundleClaims: (all: Skill[]) => Promise<Map<string, string>>,
): Promise<void> {
  const existing = await opts.skills.list();
  const { orgScope } = tenant();
  const claimed = new Map<string, string>();
  for (const skill of existing) {
    if (skill.status !== "published" || skill.scopeId !== orgScope || skill.createdBy === LAYER_CREATED_BY) continue;
    for (const path of persistedSkillRecordPaths(skill.manifest.name, skill.manifest.files))
      claimed.set(path, `skill "${skill.manifest.name}" created by ${skill.createdBy}`);
  }
  for (const [path, owner] of await activeBundleClaims(existing)) claimed.set(path, owner);
  for (const manifest of manifests) {
    const clash = foreignSkillCollision(
      existing,
      orgScope,
      manifest.name,
      (skill) => skill.createdBy === LAYER_CREATED_BY,
    );
    if (clash) {
      throw new DeploymentLayerValidationError(
        `deployment layer skill "${manifest.name}" collides with an existing skill created by ${clash.createdBy} — rename it or remove the colliding skill`,
      );
    }
    const pathClash = detectPathCollisions(skillRecordPaths(manifest.name, manifest.files), claimed)[0];
    if (pathClash) {
      throw new DeploymentLayerValidationError(
        `deployment layer skill "${manifest.name}" materializes over ${pathClash.path}, already claimed by ${pathClash.owner}`,
      );
    }
  }
}

function layerCandidate(
  input: DeploymentLayerBundle,
  updatedBy: string,
  updatedAt: number,
): { candidate: StoredDeploymentLayer; manifests: SkillManifest[] } {
  let validated: ReturnType<typeof validateBundle>;
  try {
    validated = validateBundle(input, "durable:pending");
  } catch (error) {
    throw new DeploymentLayerValidationError(errMessage(error), { cause: error });
  }
  const revision = { contentHash: contentHash(validated.bundle), version: 1, updatedAt, updatedBy };
  const candidate = {
    ...revision,
    bundle: validated.bundle,
    resolved: publicResolved(validated.runtime),
    pendingAudits: [revision],
  };
  return { candidate, manifests: validated.manifests };
}

function nextLayerRecord(
  current: StoredDeploymentLayer | null,
  candidate: StoredDeploymentLayer,
): StoredDeploymentLayer {
  if (!current) return candidate;
  if (current.contentHash === candidate.contentHash) return current;
  const { contentHash: hash, updatedAt, updatedBy } = candidate;
  const version = current.version + 1;
  return {
    ...candidate,
    version,
    pendingAudits: [...pendingAuditRevisions(current), { contentHash: hash, version, updatedAt, updatedBy }],
  };
}

function liveDeploymentLayer(runtime: DeploymentLayerRuntime): ReturnType<DeploymentLayerStore["live"]> {
  if (!runtime.dir) return { source: "none", contentHash: null, resolved: null };
  const durable = runtime.dir.startsWith("durable:");
  return {
    source: durable ? "durable" : "filesystem",
    contentHash: durable ? runtime.dir.slice("durable:".length) : null,
    resolved: publicResolved(runtime),
  };
}

export function createDeploymentLayerStore(opts: DeploymentLayerStoreOptions): DeploymentLayerStore {
  const now = opts.now ?? Date.now;
  const layer = typedTable<StoredDeploymentLayer>(
    createPgPool(opts.databaseUrl, [DEPLOYMENT_LAYER_MIGRATION]),
    DEPLOYMENT_LAYER,
  );
  const retrying = retryingWith(opts.retryDelaysMs ?? [250, 1000, 4000]);
  const projection = layerProjection(opts, retrying);
  const state = perTenant(() => ({
    appliedHash: null as string | null,
    failedHash: null as string | null,
    seeded: false,
  }));
  const queue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock;
  const withFleetLock = <T>(fn: () => Promise<T>): Promise<T> => advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, fn);

  const reportApplyFailure = (record: StoredDeploymentLayer, error: unknown): void => {
    if (state().failedHash === record.contentHash) return;
    state().failedHash = record.contentHash;
    console.error(
      `[deployment-layer] stored layer ${record.contentHash} failed to apply — keeping the current runtime layer until a valid layer is PUT: ${errMessage(error)}`,
    );
  };

  const apply = async (record: StoredDeploymentLayer): Promise<void> => {
    const { manifests, runtime: nextRuntime } = validateBundle(record.bundle, `durable:${record.contentHash}`);
    const s = state();
    if (
      s.appliedHash === record.contentHash &&
      (await projection.projectionMatches(record, { bundle: record.bundle, manifests, runtime: nextRuntime }))
    )
      return;
    s.appliedHash = null;
    await projection.project(manifests, nextRuntime);
    s.appliedHash = record.contentHash;
    s.failedHash = null;
  };

  const auditPersisted = async (record: StoredDeploymentLayer, strict: boolean): Promise<void> => {
    if (!opts.auditPersisted) return;
    const pending = pendingAuditRevisions(record);
    for (const revision of pending) {
      try {
        await retrying(() => opts.auditPersisted!({ ...record, ...revision }));
        await retrying(async () => {
          const current = await layer.get(CURRENT);
          if (!current) throw new Error("deployment layer disappeared while reconciling its audit");
          const pendingAudits = (current.pendingAudits ?? []).filter((entry) => entry.version !== revision.version);
          await layer.put(CURRENT, { ...current, pendingAudits });
        });
      } catch (error) {
        if (strict) throw error;
        console.error(
          `[deployment-layer] could not reconcile audit for stored layer revision ${revision.version} (${revision.contentHash}): ${errMessage(error)}`,
        );
        return;
      }
    }
  };

  const applyForHydrate = async (record: StoredDeploymentLayer): Promise<StoredDeploymentLayer> => {
    try {
      await apply(record);
    } catch (error) {
      reportApplyFailure(record, error);
      if (!(error instanceof DeploymentLayerMutationError) && opts.seedFallback && !state().seeded) {
        await opts.seedFallback();
        state().seeded = true;
      }
    }
    return record;
  };

  return {
    isApplied: async (hash) => {
      if (state().appliedHash !== hash) return false;
      try {
        const record = await layer.get(CURRENT);
        return record?.contentHash === hash && projection.projectionMatches(record);
      } catch {
        return false;
      }
    },
    live: () => liveDeploymentLayer(opts.runtime),
    hydrate: () =>
      queue(CURRENT, () =>
        withFleetLock(async () => {
          const record = await retrying(() => layer.get(CURRENT));
          if (record) {
            await auditPersisted(record, false);
            return applyForHydrate(record);
          }
          if (opts.seedFallback && !state().seeded) {
            await opts.seedFallback();
            state().seeded = true;
            let appeared: StoredDeploymentLayer | null = null;
            try {
              appeared = await retrying(() => layer.get(CURRENT));
            } catch (error) {
              reportFailure(
                "deployment-layer: recheck after seeding",
                error,
                "serving the filesystem fallback until refresh",
              );
            }
            if (appeared) return applyForHydrate(appeared);
          }
          return null;
        }),
      ),
    get: () =>
      queue(CURRENT, () =>
        withFleetLock(async () => {
          const record = await layer.get(CURRENT);
          if (!record) return null;
          await auditPersisted(record, false);
          if (state().failedHash !== record.contentHash) {
            try {
              await apply(record);
            } catch (error) {
              reportApplyFailure(record, error);
            }
          }
          return record;
        }),
      ),
    put: (input, updatedBy) =>
      queue(CURRENT, async () => {
        const { candidate, manifests } = layerCandidate(input, updatedBy, now());
        return withFleetLock(async () => {
          await assertPutAllowed(opts, manifests, projection.activeBundleClaims);
          const current = await layer.get(CURRENT);
          const record = nextLayerRecord(current, candidate);
          if (record !== current) await layer.put(CURRENT, record);
          try {
            await auditPersisted(record, true);
            await apply(record);
          } catch (error) {
            if (error instanceof DeploymentLayerPersistedError) throw error;
            throw new DeploymentLayerPersistedError(errMessage(error), record, { cause: error });
          }
          return record;
        });
      }),
  };
}
