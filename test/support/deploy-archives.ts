import type { DeployGitArchive, DeployGitArchives } from "../../src/deploy/deploy-git-store.ts";

export function memoryArchives(): DeployGitArchives & { rows: Map<string, DeployGitArchive> } {
  const rows = new Map<string, DeployGitArchive>();
  return {
    rows,
    get: async (id) => structuredClone(rows.get(id) ?? null),
    async put(id, archive) {
      rows.set(id, structuredClone(archive));
    },
    async update(id, fn) {
      const current = rows.get(id);
      if (current) rows.set(id, structuredClone(fn(structuredClone(current))));
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}
