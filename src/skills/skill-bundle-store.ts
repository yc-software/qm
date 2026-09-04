import { createHash } from "node:crypto";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import type { SkillFile } from "./skill-store.ts";

export interface SkillBundle {
  packId: string;
  commit: string;
  files: SkillFile[];
  hash: string;
}

export function computeBundleHash(files: SkillFile[]): string {
  const h = createHash("sha256");
  for (const e of [...files].map((f) => `${f.path}\0${f.content}`).sort()) {
    h.update(e);
    h.update("\n");
  }
  return h.digest("hex");
}

export interface SkillBundleStore {
  get(packId: string): Promise<SkillBundle | null>;
  put(bundle: SkillBundle): Promise<void>;
  delete(packId: string): Promise<void>;
  list(): Promise<SkillBundle[]>;
}

export function createSkillBundleStore(opts: { backing?: DurableMap<SkillBundle> } = {}): SkillBundleStore {
  const bundles = opts.backing ?? createMemoryMap<SkillBundle>();
  return {
    get: (packId) => bundles.get(packId),
    async put(bundle) {
      await bundles.put(bundle.packId, bundle);
    },
    delete: (packId) => bundles.delete(packId),
    list: () => bundles.all(),
  };
}
