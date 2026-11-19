import type { PoolClient } from "pg";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import { hashId } from "../util/crypto.ts";
import { createHmac, randomUUID } from "node:crypto";
import type { SkillBundle } from "./skill-bundle-store.ts";
import type { ScopeId } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { assertSafeSkillName, isSafeSkillName } from "./skill-name.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { trimTrailingSlashes } from "../util/text.ts";
import { mergeSourceProvenance, type SourceProvenance } from "../memory/facts.ts";

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
  const p = trimTrailingSlashes(path.replace(/\\/g, "/").replace(/^\.\/+/, ""));
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
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
  version: number;
  grantedCapabilities: string[];
  approvals: string[];
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
  pack?: { packId: string; commit: string; upstreamName: string };
}

export function skillSharingRevision(skill: Skill): string {
  const { lastUsedAt: _lastUsedAt, ...selected } = skill;
  return hashId([canonicalJson(selected)], 64);
}

export interface GrantedSkillRef {
  id: string;
  ownerScopeId: ScopeId;
}

export function skillAllowedInContext(
  skill: Pick<Skill, "personalOnly" | "scopeId">,
  actorId: string,
  contextScopeId?: ScopeId,
): boolean {
  return (
    !skill.personalOnly ||
    (skill.scopeId === personalScope(actorId) && (contextScopeId === undefined || contextScopeId === skill.scopeId))
  );
}

export interface SkillResolution {
  screenedBundles?: SkillBundle[];
  skill: Skill | null;
  shadowed: Skill[];
}

export interface SkillStoreOptions {
  signingSecret?: string;
  backing: DurableMap<Skill>;
  advisoryLock: AdvisoryLock;
}

export interface SkillStore {
  releasePrivate(
    id: string,
    revision: string,
    provenance: SourceProvenance,
    writeGrant: (transaction: PoolClient) => Promise<void>,
  ): Promise<Skill>;
  create(input: {
    scopeId: ScopeId;
    manifest: SkillManifest;
    createdBy: string;
    personalOnly?: true;
    sourceProvenance?: SourceProvenance;
    pack?: Skill["pack"];
  }): Promise<Skill>;
  update(
    id: string,
    manifest: SkillManifest,
    sourceProvenance?: SourceProvenance,
    expectedRevision?: string,
  ): Promise<Skill>;
  withNameLock<T>(scopeId: ScopeId, name: string, fn: () => Promise<T>): Promise<T>;
  get(id: string): Promise<Skill | null>;
  list(): Promise<Skill[]>;
  verify(skill: Skill): boolean;
  review(id: string, reviewer: string, grantCapabilities: string[]): Promise<Skill>;
  publish(id: string): Promise<Skill>;
  archive(id: string): Promise<Skill>;
  restore(skill: Skill): Promise<void>;
  delete(id: string): Promise<void>;
  recordUse(id: string, at?: number): Promise<void>;
  resolve(name: string, orderedScopes: ScopeId[], personalScopeId?: ScopeId): Promise<SkillResolution>;
  visibleFor(
    orderedScopes: ScopeId[],
    granted?: readonly GrantedSkillRef[],
    personalScopeId?: ScopeId,
  ): Promise<SkillResolution[]>;
  promote(id: string, targetScopeId: ScopeId, expectedRevision?: string): Promise<Skill>;
  move(id: string, toScopeId: ScopeId, expectedRevision?: string): Promise<Skill>;
}

export function foreignSkillCollision(
  all: Skill[],
  scopeId: ScopeId,
  name: string,
  isOwn: (skill: Skill) => boolean,
): Skill | undefined {
  return all.find((s) => s.scopeId === scopeId && s.manifest.name === name && !isOwn(s) && s.status !== "archived");
}

function scopeKind(scopeId: ScopeId): string {
  return parseScopeId(scopeId).kind ?? scopeId;
}

export type SkillSummary = Pick<Skill, "id" | "scopeId" | "status"> & { manifest: Pick<SkillManifest, "name"> };

function publishedByScopeAndName<T extends SkillSummary>(all: T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const s of all) {
    if (s.status !== "published") continue;
    const key = `${s.scopeId}\u0000${s.manifest.name}`;
    if (!index.has(key)) index.set(key, s);
  }
  return index;
}

function resolveFromIndex<T extends SkillSummary>(
  index: Map<string, T>,
  name: string,
  orderedScopes: ScopeId[],
): { skill: T | null; shadowed: T[] } {
  if (!isSafeSkillName(name)) return { skill: null, shadowed: [] };
  const published = orderedScopes.map((sc) => index.get(`${sc}\u0000${name}`)).filter((s): s is T => Boolean(s));
  const [skill, ...shadowed] = published;
  return { skill: skill ?? null, shadowed };
}

export function visibleSkillRows<T extends SkillSummary>(
  all: T[],
  orderedScopes: ScopeId[],
  granted?: readonly GrantedSkillRef[],
): Array<{ skill: T; shadowed: T[] }> {
  const index = publishedByScopeAndName(all);
  const inScope = new Set(orderedScopes);
  const names = [
    ...new Set(
      all
        .filter((s) => s.status === "published" && inScope.has(s.scopeId) && isSafeSkillName(s.manifest.name))
        .map((s) => s.manifest.name),
    ),
  ];
  const visible = names
    .map((n) => resolveFromIndex(index, n, orderedScopes))
    .filter((r): r is { skill: T; shadowed: T[] } => r.skill !== null);
  if (granted?.length) {
    const byId = new Map(all.map((skill) => [skill.id, skill]));
    const byName = new Map(visible.map((r) => [r.skill.manifest.name, r]));
    const seen = new Set<string>();
    for (const ref of granted) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const s = byId.get(ref.id);
      if (!s || s.status !== "published" || s.scopeId !== ref.ownerScopeId || !isSafeSkillName(s.manifest.name))
        continue;
      const existing = byName.get(s.manifest.name);
      if (existing) {
        if (existing.skill.id !== s.id && !existing.shadowed.some((x) => x.id === s.id)) existing.shadowed.push(s);
        continue;
      }
      const r = { skill: s, shadowed: [] as T[] };
      byName.set(s.manifest.name, r);
      visible.push(r);
    }
  }
  return visible;
}

export function createSkillStore(opts: SkillStoreOptions): SkillStore {
  const skills = opts.backing;
  const inScopes = async (scopes: readonly ScopeId[]): Promise<Skill[]> => {
    const wanted = new Set<string>(scopes);
    const rows = await skills.select({ where: { field: "scopeId", anyOfFold: [...wanted] } });
    return rows.filter((skill) => wanted.has(skill.scopeId));
  };
  const secret = opts.signingSecret ?? randomUUID();
  const advisoryLock = opts.advisoryLock;
  const withNameLock = <T>(scopeId: ScopeId, name: string, fn: () => Promise<T>) =>
    advisoryLock.withLock(`skill-name:${scopeId}:${name}`, fn);

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
    async releasePrivate(id, revision, provenance, writeGrant) {
      const selected = await skills.get(id);
      if (!selected) throw new Error("The selected skill no longer exists.");
      return withNameLock(selected.scopeId, selected.manifest.name, async () => {
        const released = await skills.updateInTransaction(id, async (current, transaction) => {
          if (!current.personalOnly || current.status === "archived" || skillSharingRevision(current) !== revision)
            throw new Error("The selected private skill changed after approval. Read it again before sharing.");
          if (sign(current.manifest) !== current.signature)
            throw new Error("The selected skill's signature is invalid.");
          await writeGrant(transaction);
          const { personalOnly: _personalOnly, ...shared } = current;
          return { ...shared, sourceProvenance: provenance };
        });
        if (!released) throw new Error("The selected skill no longer exists.");
        return released;
      });
    },
    withNameLock,
    async create(input) {
      assertSafeSkillName(input.manifest.name);
      if (input.personalOnly && scopeKind(input.scopeId) !== "personal")
        throw new Error("Private skills require a personal scope");
      const at = Date.now();
      const skill: Skill = {
        id: randomUUID(),
        scopeId: input.scopeId,
        manifest: input.manifest,
        signature: sign(input.manifest),
        status: "draft",
        createdBy: input.createdBy,
        ...(input.personalOnly ? { personalOnly: true as const } : {}),
        ...(input.sourceProvenance ? { sourceProvenance: input.sourceProvenance } : {}),
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
    async update(id, manifest, sourceProvenance, expectedRevision) {
      assertSafeSkillName(manifest.name);
      const updated = await skills.update(id, (s) => {
        if (expectedRevision && skillSharingRevision(s) !== expectedRevision)
          throw new Error("The selected skill changed before editing.");
        if (manifest.name !== s.manifest.name)
          throw new Error("skill update cannot rename — create a new skill instead");
        s.manifest = manifest;
        if (sourceProvenance)
          s.sourceProvenance = mergeSourceProvenance([
            ...(s.sourceProvenance ? [s.sourceProvenance] : []),
            sourceProvenance,
          ]);
        s.signature = sign(manifest);
        if (scopeKind(s.scopeId) !== "personal") s.status = "draft";
        s.version += 1;
        s.updatedAt = Date.now();
        return s;
      });
      if (!updated) throw new Error(`unknown skill: ${id}`);
      return updated;
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
      const existing = await skills.get(id);
      if (!existing) throw new Error(`unknown skill: ${id}`);
      return withNameLock(existing.scopeId, existing.manifest.name, async () => {
        const s = await skills.get(id);
        if (!s) throw new Error(`unknown skill: ${id}`);
        if (s.status === "archived") return s;
        s.status = "archived";
        s.updatedAt = Date.now();
        await skills.put(s.id, s);
        return s;
      });
    },

    async restore(skill) {
      assertSafeSkillName(skill.manifest.name);
      const current = await skills.get(skill.id);
      if (current?.personalOnly && skill.scopeId !== current.scopeId)
        throw new Error("Private skills cannot change audience");
      const restored = structuredClone(skill);
      if (current?.personalOnly) restored.personalOnly = true;
      if (current?.sourceProvenance)
        restored.sourceProvenance = mergeSourceProvenance([
          current.sourceProvenance,
          ...(restored.sourceProvenance ? [restored.sourceProvenance] : []),
        ]);
      if (restored.personalOnly && scopeKind(restored.scopeId) !== "personal")
        throw new Error("Private skills require a personal scope");
      await skills.put(skill.id, restored);
    },

    async delete(id) {
      await skills.delete(id);
    },

    async recordUse(id, at) {
      await skills.merge(id, { lastUsedAt: at ?? Date.now() });
    },

    async resolve(name, orderedScopes, personalScopeId) {
      const visible = (await inScopes(orderedScopes)).filter(
        (skill) => !skill.personalOnly || skill.scopeId === personalScopeId,
      );
      return resolveFromIndex(publishedByScopeAndName(visible), name, orderedScopes);
    },

    async visibleFor(orderedScopes, granted, personalScopeId) {
      const all = await inScopes([...orderedScopes, ...(granted ?? []).map((ref) => ref.ownerScopeId)]);
      return visibleSkillRows(
        all.filter((skill) => !skill.personalOnly || skill.scopeId === personalScopeId),
        orderedScopes,
        granted,
      );
    },

    async promote(id, targetScopeId, expectedRevision) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      if (expectedRevision && skillSharingRevision(s) !== expectedRevision)
        throw new Error("The selected skill changed before promotion.");
      if (s.personalOnly && targetScopeId !== s.scopeId) throw new Error("Private skills cannot change audience");
      assertSafeSkillName(s.manifest.name);
      if (s.status !== "published") throw new Error("only a published skill can be promoted");
      if (sign(s.manifest) !== s.signature) throw new Error("skill signature invalid — cannot promote");
      return withNameLock(targetScopeId, s.manifest.name, async () => {
        const existing = foreignSkillCollision(
          await inScopes([targetScopeId]),
          targetScopeId,
          s.manifest.name,
          () => false,
        );
        const at = Date.now();
        const promoted: Skill = {
          id: existing?.id ?? randomUUID(),
          scopeId: targetScopeId,
          manifest: s.manifest,
          signature: sign(s.manifest),
          status: "published",
          createdBy: s.createdBy,
          ...(s.personalOnly || existing?.personalOnly ? { personalOnly: true as const } : {}),
          ...(s.sourceProvenance || existing?.sourceProvenance
            ? {
                sourceProvenance: mergeSourceProvenance([
                  ...(s.sourceProvenance ? [s.sourceProvenance] : []),
                  ...(existing?.sourceProvenance ? [existing.sourceProvenance] : []),
                ]),
              }
            : {}),
          version: (existing?.version ?? 0) + 1,
          grantedCapabilities: [...s.grantedCapabilities],
          approvals: [...s.approvals],
          createdAt: at,
          updatedAt: at,
        };
        await skills.put(promoted.id, promoted);
        return promoted;
      });
    },

    async move(id, toScopeId, expectedRevision) {
      const s = await skills.get(id);
      if (!s) throw new Error(`unknown skill: ${id}`);
      if (s.personalOnly && toScopeId !== s.scopeId) throw new Error("Private skills cannot change audience");
      assertSafeSkillName(s.manifest.name);
      if (scopeKind(toScopeId) === "org") {
        throw new Error("ceding a skill to the org goes through promote (admin-gated), not move");
      }
      const moved = await advisoryLock.tryWithLocks(
        [`skill-name:${s.scopeId}:${s.manifest.name}`, `skill-name:${toScopeId}:${s.manifest.name}`],
        async () => {
          if (foreignSkillCollision(await inScopes([toScopeId]), toScopeId, s.manifest.name, (x) => x.id === id))
            throw new Error(`a skill named ${s.manifest.name} already exists there`);
          const current = await skills.get(id);
          if (!current) throw new Error(`unknown skill: ${id}`);
          if (expectedRevision && skillSharingRevision(current) !== expectedRevision)
            throw new Error("The selected skill changed before moving.");
          current.scopeId = toScopeId;
          current.updatedAt = Date.now();
          await skills.put(current.id, current);
          return current;
        },
      );
      if (!moved) throw new Error("The skill is being changed. Try moving it again.");
      return moved;
    },
  };
}
