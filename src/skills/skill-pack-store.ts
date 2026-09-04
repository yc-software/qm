import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { PackConfig } from "./normalize.ts";

type PackKind = "git";
type SyncMode = "pinned" | "tracked";
type TrustTier = "internal" | "third-party";

interface ImportRecord {
  at: number;
  commit: string;
  status: "ok" | "error";
  error?: string;
  counts?: Record<string, number>;
}

export interface SkillPack {
  id: string;
  kind: PackKind;
  url: string;
  ref: string;
  syncMode: SyncMode;
  trustTier: TrustTier;
  config?: PackConfig;
  targetScopeId: ScopeId;
  subset: "all" | string[];
  authCredentialSlug?: string;
  createdBy: string;
  createdAt: number;
  lastImport?: ImportRecord;
  updateAvailable?: boolean;
  available?: number;
}

export type NewSkillPack = Omit<SkillPack, "id" | "createdAt" | "lastImport">;

export interface SkillPackStore {
  create(input: NewSkillPack): Promise<SkillPack>;
  get(id: string): Promise<SkillPack | null>;
  list(): Promise<SkillPack[]>;
  update(id: string, patch: Partial<Omit<SkillPack, "id" | "createdAt">>): Promise<SkillPack>;
  remove(id: string): Promise<void>;
  recordImport(id: string, result: ImportRecord): Promise<void>;
}

export function createSkillPackStore(
  opts: { backing?: DurableMap<SkillPack>; now?: () => number } = {},
): SkillPackStore {
  const packs = opts.backing ?? createMemoryMap<SkillPack>();
  const now = opts.now ?? (() => Date.now());
  return {
    async create(input) {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: now() };
      await packs.put(pack.id, pack);
      return pack;
    },
    get: (id) => packs.get(id),
    list: () => packs.all(),
    async update(id, patch) {
      const merged = await packs.merge(id, patch);
      if (!merged) throw new Error(`unknown skill pack: ${id}`);
      return merged;
    },
    remove: (id) => packs.delete(id),
    async recordImport(id, result) {
      await packs.merge(id, { lastImport: result });
    },
  };
}
