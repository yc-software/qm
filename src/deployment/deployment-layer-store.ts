import { createHash } from "node:crypto";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";
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
import { errMessage } from "../util/errors.ts";
import { parseToolDescriptor, type ToolDescriptor } from "./deployment-layer.ts";
import { replaceDeploymentLayer, resolvedDeploymentLayer, type DeploymentLayerRuntime } from "./load-layer.ts";

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
  durable: boolean;
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
export const LAYER_CREATED_BY = "system:deployment-layer";
export const LAYER_REVIEWER = "system:deployment-layer-reviewer";
const pathOrder = (a: DeploymentLayerFile, b: DeploymentLayerFile): number => {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
};

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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

function toolDescriptors(files: DeploymentLayerFile[]): ToolDescriptor[] {
  const tools = files.map((file) => {
    if (!/^tools\/[^/]+\/tool\.json$/.test(file.path)) {
      throw new Error(`deployment layer tool path must be tools/<id>/tool.json: ${file.path}`);
    }
    return parseToolDescriptor(file.content, file.path);
  });
  const ids = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) throw new Error(`duplicate deployment tool id: ${tool.id}`);
    ids.add(tool.id);
  }
  return tools;
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
  const tools = toolDescriptors(bundle.tools);
  const manifests = skillManifests(bundle.skills);
  return { bundle, manifests, runtime: resolvedDeploymentLayer(dir, tools) };
}

export function createDeploymentLayerStore(opts: {
  backing: DurableMap<StoredDeploymentLayer>;
  runtime: DeploymentLayerRuntime;
  skills: SkillStore;
  skillBundles?: SkillBundleStore;
  scopeId: ScopeId;
  seedFallback?: () => Promise<unknown>;
  durable?: boolean;
  now?: () => number;
  retryDelaysMs?: readonly number[];
  advisoryLock?: AdvisoryLock;
  auditPersisted?: (record: StoredDeploymentLayer) => Promise<void>;
}): DeploymentLayerStore {
  const now = opts.now ?? Date.now;
  const retryDelaysMs = opts.retryDelaysMs ?? [250, 1000, 4000];
  let appliedHash: string | null = null;
  let failedHash: string | null = null;
  let seeded = false;
  const queue = createKeyedQueue<string>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const withFleetLock = <T>(fn: () => Promise<T>): Promise<T> => advisoryLock.withLock(SKILL_MATERIALIZATION_LOCK, fn);

  const retrying = async <T>(fn: () => Promise<T>): Promise<T> => {
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

  const reportApplyFailure = (record: StoredDeploymentLayer, error: unknown): void => {
    if (failedHash === record.contentHash) return;
    failedHash = record.contentHash;
    console.error(
      `[deployment-layer] stored layer ${record.contentHash} failed to apply — keeping the current runtime layer until a valid layer is PUT: ${errMessage(error)}`,
    );
  };

  const layerSkills = (all: Skill[]): Skill[] =>
    all.filter((skill) => skill.scopeId === opts.scopeId && skill.createdBy === LAYER_CREATED_BY);

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

  const apply = async (record: StoredDeploymentLayer): Promise<void> => {
    const { manifests, runtime: nextRuntime } = validateBundle(record.bundle, `durable:${record.contentHash}`);
    if (
      appliedHash === record.contentHash &&
      (await projectionMatches(record, { bundle: record.bundle, manifests, runtime: nextRuntime }))
    )
      return;
    appliedHash = null;
    const all = await opts.skills.list();
    const snapshot = layerSkills(all).map((skill) => structuredClone(skill));
    const wanted = new Set<string>();
    try {
      await assertNoBundleCollisions(manifests, all);
      for (const manifest of manifests) {
        wanted.add(manifest.name);
        const outcome = await upsertSeedSkill(opts.skills, {
          scopeId: opts.scopeId,
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
          skill.scopeId === opts.scopeId &&
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
    appliedHash = record.contentHash;
    failedHash = null;
  };

  const auditPersisted = async (record: StoredDeploymentLayer, strict: boolean): Promise<void> => {
    if (!opts.auditPersisted) return;
    const pending = pendingAuditRevisions(record);
    for (const revision of pending) {
      try {
        await retrying(() => opts.auditPersisted!({ ...record, ...revision }));
        if (!opts.backing.update)
          throw new Error("deployment layer backing store must support atomic audit reconciliation");
        await retrying(async () => {
          const updated = await opts.backing.update!(CURRENT, (current) => ({
            ...current,
            pendingAudits: (current.pendingAudits ?? []).filter((entry) => entry.version !== revision.version),
          }));
          if (!updated) throw new Error("deployment layer disappeared while reconciling its audit");
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
      if (!(error instanceof DeploymentLayerMutationError) && opts.seedFallback && !seeded) {
        await opts.seedFallback();
        seeded = true;
      }
    }
    return record;
  };

  return {
    durable: opts.durable ?? false,
    isApplied: async (hash) => {
      if (appliedHash !== hash) return false;
      try {
        const record = await opts.backing.get(CURRENT);
        return record?.contentHash === hash && projectionMatches(record);
      } catch {
        return false;
      }
    },
    live: () => {
      if (!opts.runtime.dir) return { source: "none", contentHash: null, resolved: null };
      const durable = opts.runtime.dir.startsWith("durable:");
      return {
        source: durable ? "durable" : "filesystem",
        contentHash: durable ? opts.runtime.dir.slice("durable:".length) : null,
        resolved: publicResolved(opts.runtime),
      };
    },
    hydrate: () =>
      queue(CURRENT, () =>
        withFleetLock(async () => {
          const record = await retrying(() => opts.backing.get(CURRENT));
          if (record) {
            await auditPersisted(record, false);
            return applyForHydrate(record);
          }
          if (opts.seedFallback && !seeded) {
            await opts.seedFallback();
            seeded = true;
            let appeared: StoredDeploymentLayer | null = null;
            try {
              appeared = await retrying(() => opts.backing.get(CURRENT));
            } catch (error) {
              console.error(
                `[deployment-layer] could not recheck the durable layer after seeding — serving the filesystem fallback until refresh: ${errMessage(error)}`,
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
          const record = await opts.backing.get(CURRENT);
          if (!record) return null;
          await auditPersisted(record, false);
          if (failedHash !== record.contentHash) {
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
        let bundle: DeploymentLayerBundle;
        let manifests: SkillManifest[];
        let runtime: DeploymentLayerRuntime;
        try {
          const validated = validateBundle(input, "durable:pending");
          bundle = validated.bundle;
          manifests = validated.manifests;
          runtime = validated.runtime;
        } catch (error) {
          throw new DeploymentLayerValidationError(errMessage(error), { cause: error });
        }
        const hash = contentHash(bundle);
        const candidate: StoredDeploymentLayer = {
          contentHash: hash,
          version: 1,
          updatedAt: now(),
          updatedBy,
          bundle,
          resolved: publicResolved(runtime),
          pendingAudits: [],
        };
        return withFleetLock(async () => {
          const existing = await opts.skills.list();
          const claimed = new Map<string, string>();
          for (const skill of existing) {
            if (skill.status !== "published" || skill.scopeId !== opts.scopeId || skill.createdBy === LAYER_CREATED_BY)
              continue;
            for (const path of persistedSkillRecordPaths(skill.manifest.name, skill.manifest.files))
              claimed.set(path, `skill "${skill.manifest.name}" created by ${skill.createdBy}`);
          }
          for (const [path, owner] of await activeBundleClaims(existing)) claimed.set(path, owner);
          for (const manifest of manifests) {
            const clash = foreignSkillCollision(existing, opts.scopeId, manifest.name, LAYER_CREATED_BY);
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
          candidate.pendingAudits = [
            {
              contentHash: candidate.contentHash,
              version: candidate.version,
              updatedAt: candidate.updatedAt,
              updatedBy: candidate.updatedBy,
            },
          ];
          let record = await opts.backing.putIfAbsent(CURRENT, candidate);
          if (record.contentHash !== hash) {
            if (!opts.backing.update) throw new Error("deployment layer backing store must support atomic updates");
            const updated = await opts.backing.update(CURRENT, (current) => {
              if (current.contentHash === hash) return current;
              const version = current.version + 1;
              return {
                ...candidate,
                version,
                pendingAudits: [
                  ...pendingAuditRevisions(current),
                  {
                    contentHash: candidate.contentHash,
                    version,
                    updatedAt: candidate.updatedAt,
                    updatedBy: candidate.updatedBy,
                  },
                ],
              };
            });
            if (!updated) throw new Error("deployment layer write conflicted with a concurrent delete; retry");
            record = updated;
          }
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
