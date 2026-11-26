import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { safeSkillFilePath, type CatalogSkill, type SkillFile, type SkillManifest } from "../skills/skill-store.ts";
import { parseSeedSkill } from "../skills/seed.ts";
import { detectPathCollisions, skillRecordPaths } from "../skills/skill-collision.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { errMessage } from "../util/errors.ts";
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
  skills(): readonly CatalogSkill[];
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

const CURRENT = "current";
export const LAYER_CREATED_BY = "system:deployment-layer";
export const LAYER_REVIEWER = "system:deployment-layer-reviewer";
export const DEPLOYMENT_LAYER_CHANNEL = "deployment_layer";
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
        if (!file.path.isWellFormed() || !file.content.isWellFormed()) {
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

export function createDeploymentLayerStore(opts: {
  backing: DurableMap<StoredDeploymentLayer>;
  runtime: DeploymentLayerRuntime;
  fallbackSkills?: SkillManifest[];
  builtinSkills?: CatalogSkill[];
  now?: () => number;
  retryDelaysMs?: readonly number[];
  auditPersisted?: (record: StoredDeploymentLayer) => Promise<void>;
  published?: () => void;
}): DeploymentLayerStore {
  const now = opts.now ?? Date.now;
  const retryDelaysMs = opts.retryDelaysMs ?? [250, 1000, 4000];
  let appliedHash: string | null = null;
  let failedHash: string | null = null;
  let catalog: CatalogSkill[] = [];
  const queue = createKeyedQueue<string>();

  const useLayerSkills = (manifests: SkillManifest[]): void => {
    const byName = new Map<string, CatalogSkill>();
    for (const skill of [
      ...manifests.map((manifest) => ({ manifest, createdBy: LAYER_CREATED_BY, reviewer: LAYER_REVIEWER })),
      ...(opts.builtinSkills ?? []),
    ]) {
      if (!byName.has(skill.manifest.name)) byName.set(skill.manifest.name, skill);
    }
    catalog = [...byName.values()];
  };
  useLayerSkills(opts.fallbackSkills ?? []);

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

  const apply = (record: StoredDeploymentLayer): void => {
    if (appliedHash === record.contentHash || failedHash === record.contentHash) return;
    try {
      const { manifests, runtime } = validateBundle(record.bundle, `durable:${record.contentHash}`);
      replaceDeploymentLayer(opts.runtime, runtime);
      useLayerSkills(manifests);
      appliedHash = record.contentHash;
      failedHash = null;
    } catch (error) {
      failedHash = record.contentHash;
      console.error(
        `[deployment-layer] stored layer ${record.contentHash} failed to apply — keeping the current runtime layer until a valid layer is PUT: ${errMessage(error)}`,
      );
    }
  };

  const auditPersisted = async (record: StoredDeploymentLayer, strict: boolean): Promise<void> => {
    if (!opts.auditPersisted) return;
    const pending = pendingAuditRevisions(record);
    for (const revision of pending) {
      try {
        await retrying(() => opts.auditPersisted!({ ...record, ...revision }));
        await retrying(async () => {
          const updated = await opts.backing.update(CURRENT, (current) => ({
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

  return {
    skills: () => catalog,
    isApplied: async (hash) => appliedHash === hash,
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
      queue(CURRENT, async () => {
        const record = await retrying(() => opts.backing.get(CURRENT));
        if (record) apply(record);
        return record;
      }),
    get: () =>
      queue(CURRENT, async () => {
        const record = await opts.backing.get(CURRENT);
        if (!record) return null;
        await auditPersisted(record, false);
        apply(record);
        return record;
      }),
    put: (input, updatedBy) =>
      queue(CURRENT, async () => {
        let bundle: DeploymentLayerBundle;
        let runtime: DeploymentLayerRuntime;
        try {
          ({ bundle, runtime } = validateBundle(input, "durable:pending"));
        } catch (error) {
          throw new DeploymentLayerValidationError(errMessage(error), { cause: error });
        }
        const hash = contentHash(bundle);
        const revision = { contentHash: hash, version: 1, updatedAt: now(), updatedBy };
        const candidate: StoredDeploymentLayer = {
          ...revision,
          bundle,
          resolved: publicResolved(runtime),
          pendingAudits: [revision],
        };
        let record = await opts.backing.putIfAbsent(CURRENT, candidate);
        if (record.contentHash !== hash) {
          const updated = await opts.backing.update(CURRENT, (current) => {
            if (current.contentHash === hash) return current;
            const version = current.version + 1;
            return {
              ...candidate,
              version,
              pendingAudits: [...pendingAuditRevisions(current), { ...revision, version }],
            };
          });
          if (!updated) throw new Error("deployment layer write conflicted with a concurrent delete; retry");
          record = updated;
        }
        apply(record);
        try {
          opts.published?.();
          await auditPersisted(record, true);
          if (appliedHash !== record.contentHash) throw new Error(`stored layer ${record.contentHash} did not apply`);
        } catch (error) {
          throw new DeploymentLayerPersistedError(errMessage(error), record, { cause: error });
        }
        return record;
      }),
  };
}
