import { createHmac, randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { parseScopeId } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { assertSafeSkillName, isSafeSkillName } from "./skill-name.ts";

type SkillStatus = "draft" | "reviewed" | "published" | "archived";

export interface SkillFile {
  path: string;
  content: string;
  executable?: boolean;
}

export interface SkillManifest {
  name: string;
  description: string;
  requiredCapabilities: string[];
  body: string;
  files?: SkillFile[];
}

export function safeSkillFilePath(path: string): string {
  const p = path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const parts = p.split("/").filter(Boolean);
  if (
    !parts.length ||
    path.startsWith("/") ||
    parts.some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error(`invalid skill file path: ${path}`);
  }
  return parts.join("/");
}

function canonicalFiles(files: SkillFile[] | undefined): Array<[string, string, boolean]> {
  return [...(files ?? [])]
    .map((f): [string, string, boolean] => [f.path, f.content, f.executable === true])
    .sort((a, b) => {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
}

export interface Skill {
  id: string;
  scopeId: ScopeId;
  manifest: SkillManifest;
  signature: string;
  status: SkillStatus;
  createdBy: string;
  version: number;
  grantedCapabilities: string[];
  approvals: string[];
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
  pack?: { packId: string; commit: string; upstreamName: string };
}

export interface SkillResolution {
  skill: Skill | null;
  shadowed: Skill[];
}

export interface SkillStoreOptions {
  signingSecret?: string;
  backing?: DurableMap<Skill>;
}

export interface SkillStore {
  create(input: { scopeId: ScopeId; manifest: SkillManifest; createdBy: string; pack?: Skill["pack"] }): Promise<Skill>;
  update(id: string, manifest: SkillManifest): Promise<Skill>;
  get(id: string): Promise<Skill | null>;
  list(): Promise<Skill[]>;
  verify(skill: Skill): boolean;
  review(id: string, reviewer: string, grantCapabilities: string[]): Promise<Skill>;
  publish(id: string): Promise<Skill>;
  archive(id: string): Promise<Skill>;
  restore(skill: Skill): Promise<void>;
  delete(id: string): Promise<void>;
  recordUse(id: string, at?: number): Promise<void>;
  resolve(name: string, orderedScopes: ScopeId[]): Promise<SkillResolution>;
  visibleFor(orderedScopes: ScopeId[]): Promise<SkillResolution[]>;
  promote(id: string, targetScopeId: ScopeId): Promise<Skill>;
  move(id: string, toScopeId: ScopeId): Promise<Skill>;
}

function scopeKind(scopeId: ScopeId): string {
  return parseScopeId(scopeId).kind ?? scopeId;
}

function publishedByScopeAndName(all: Skill[]): Map<string, Skill> {
  const index = new Map<string, Skill>();
  for (const s of all) {
    if (s.status !== "published") continue;
    const key = `${s.scopeId}\u0000${s.manifest.name}`;
    if (!index.has(key)) index.set(key, s);
  }
  return index;
}

function resolveFromIndex(index: Map<string, Skill>, name: string, orderedScopes: ScopeId[]): SkillResolution {
  if (!isSafeSkillName(name)) return { skill: null, shadowed: [] };
  const published = orderedScopes.map((sc) => index.get(`${sc}\u0000${name}`)).filter((s): s is Skill => Boolean(s));
  const [skill, ...shadowed] = published;
  return { skill: skill ?? null, shadowed };
}

export function createSkillStore(opts: SkillStoreOptions = {}): SkillStore {
  const skills = opts.backing ?? createMemoryMap<Skill>();
  const secret = opts.signingSecret ?? randomUUID();

  function sign(manifest: SkillManifest): string {
    const files = canonicalFiles(manifest.files);
    const canonical = JSON.stringify({
      name: manifest.name,
      description: manifest.description,
      requiredCapabilities: [...manifest.requiredCapabilities].sort(),
      body: manifest.body,
      ...(files.length ? { files } : {}),
    });
    return createHmac("sha256", secret).update(canonical).digest("hex");
  }

  return {
    async create(input) {
      assertSafeSkillName(input.manifest.name);
      const at = Date.now();
      const skill: Skill = {
        id: randomUUID(),
        scopeId: input.scopeId,
        manifest: input.manifest,
        signature: sign(input.manifest),
        status: "draft",
        createdBy: input.createdBy,
        version: 1,
        grantedCapabilities: [],
        approvals: [],
        createdAt: at,
        updatedAt: at,
        ...(input.pack ? { pack: input.pack } : {}),
      };
      await skills.put(skill.id, skill);
      return skill;
    },
    async update(id, manifest) {
      assertSafeSkillName(manifest.name);
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      if (manifest.name !== s.manifest.name) throw new Error("skill update cannot rename — create a new skill instead");
      s.manifest = manifest;
      s.signature = sign(manifest);
      if (scopeKind(s.scopeId) !== "personal") s.status = "draft";
      s.version += 1;
      s.updatedAt = Date.now();
      await skills.put(s.id, s);
      return s;
    },

    get: (id) => skills.get(id),
    list: () => skills.all(),

    verify(skill) {
      return sign(skill.manifest) === skill.signature;
    },

    async review(id, reviewer, grantCapabilities) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      assertSafeSkillName(s.manifest.name);
      if (sign(s.manifest) !== s.signature) throw new Error("skill signature invalid — manifest was tampered with");
      s.grantedCapabilities = [...new Set([...s.grantedCapabilities, ...grantCapabilities])];
      if (!s.approvals.includes(reviewer)) s.approvals.push(reviewer);
      s.status = "reviewed";
      s.updatedAt = Date.now();
      await skills.put(s.id, s);
      return s;
    },

    async publish(id) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      assertSafeSkillName(s.manifest.name);
      if (s.status === "draft") throw new Error("skill must be reviewed before it is published");
      const missing = s.manifest.requiredCapabilities.filter((c) => !s.grantedCapabilities.includes(c));
      if (missing.length) throw new Error(`skill requires ungranted capabilities: ${missing.join(", ")}`);
      s.status = "published";
      s.updatedAt = Date.now();
      await skills.put(s.id, s);
      return s;
    },

    async archive(id) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      if (s.status === "archived") return s;
      s.status = "archived";
      s.updatedAt = Date.now();
      await skills.put(s.id, s);
      return s;
    },

    async restore(skill) {
      assertSafeSkillName(skill.manifest.name);
      await skills.put(skill.id, structuredClone(skill));
    },

    async delete(id) {
      await skills.delete(id);
    },

    async recordUse(id, at) {
      await skills.merge(id, { lastUsedAt: at ?? Date.now() });
    },

    async resolve(name, orderedScopes) {
      return resolveFromIndex(publishedByScopeAndName(await skills.all()), name, orderedScopes);
    },

    async visibleFor(orderedScopes) {
      const all = await skills.all();
      const index = publishedByScopeAndName(all);
      const inScope = new Set(orderedScopes);
      const names = [
        ...new Set(
          all
            .filter((s) => s.status === "published" && inScope.has(s.scopeId) && isSafeSkillName(s.manifest.name))
            .map((s) => s.manifest.name),
        ),
      ];
      return names
        .map((n) => resolveFromIndex(index, n, orderedScopes))
        .filter((r): r is SkillResolution & { skill: Skill } => r.skill !== null);
    },

    async promote(id, targetScopeId) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      assertSafeSkillName(s.manifest.name);
      if (s.status !== "published") throw new Error("only a published skill can be promoted");
      if (sign(s.manifest) !== s.signature) throw new Error("skill signature invalid — cannot promote");
      const existing = (await skills.all()).find(
        (x) => x.status === "published" && x.scopeId === targetScopeId && x.manifest.name === s.manifest.name,
      );
      const at = Date.now();
      const promoted: Skill = {
        id: existing?.id ?? randomUUID(),
        scopeId: targetScopeId,
        manifest: s.manifest,
        signature: sign(s.manifest),
        status: "published",
        createdBy: s.createdBy,
        version: (existing?.version ?? 0) + 1,
        grantedCapabilities: [...s.grantedCapabilities],
        approvals: [...s.approvals],
        createdAt: at,
        updatedAt: at,
      };
      await skills.put(promoted.id, promoted);
      return promoted;
    },

    async move(id, toScopeId) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      assertSafeSkillName(s.manifest.name);
      if (scopeKind(toScopeId) === "org") {
        throw new Error("ceding a skill to the org goes through promote (admin-gated), not move");
      }
      s.scopeId = toScopeId;
      s.updatedAt = Date.now();
      await skills.put(s.id, s);
      return s;
    },
  };
}
