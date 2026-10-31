import { createHash } from "node:crypto";
import { sortedRows, tenantRows } from "../tenants/memory-rows.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { pgJsonText, pgTextSafe } from "../util/text.ts";
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
  forPacks(packIds: readonly string[]): Promise<SkillBundle[]>;
  put(bundle: SkillBundle): Promise<void>;
  delete(packId: string): Promise<void>;
  close?(): Promise<void>;
}

export function createSkillBundleStore(): SkillBundleStore {
  const bundles = tenantRows<SkillBundle>();
  return {
    get: async (packId) => bundles().get(packId) ?? null,
    forPacks: async (packIds) => sortedRows(bundles()).filter((bundle) => packIds.includes(bundle.packId)),
    put: async (bundle) => void bundles().set(bundle.packId, bundle),
    delete: async (packId) => void bundles().delete(packId),
  };
}

export const SKILL_BUNDLES_MIGRATION = typedTableMigration({
  table: "skill_bundles",
  columns: ["pack_id TEXT NOT NULL", "commit TEXT NOT NULL", "files JSONB NOT NULL", "hash TEXT NOT NULL"],
  primaryKey: ["pack_id"],
  backfill: { pack_id: "id", commit: "json->>'commit'", files: "json->'files'", hash: "json->>'hash'" },
  where: "json->>'commit' IS NOT NULL AND jsonb_typeof(json->'files') = 'array' AND json->>'hash' IS NOT NULL",
});

function bundleFromRow(row: Record<string, unknown>): SkillBundle {
  return {
    packId: String(row.pack_id),
    commit: String(row.commit),
    files: row.files as SkillFile[],
    hash: String(row.hash),
  };
}

export function createPostgresSkillBundleStore(connectionString: string): SkillBundleStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, SKILL_BUNDLES_MIGRATION]);
  return {
    async get(packId) {
      const rows = await q(`SELECT * FROM skill_bundles WHERE tenant_id = ${TENANT} AND pack_id = $1`, [packId]);
      return rows[0] ? bundleFromRow(rows[0]) : null;
    },
    async forPacks(packIds) {
      const rows = await q(
        `SELECT * FROM skill_bundles WHERE tenant_id = ${TENANT} AND pack_id = ANY($1::text[]) ORDER BY pack_id`,
        [[...packIds]],
      );
      return rows.map(bundleFromRow);
    },
    async put(bundle) {
      await q(
        `INSERT INTO skill_bundles(pack_id, commit, files, hash) VALUES ($1, $2, $3, $4)
          ON CONFLICT (tenant_id, pack_id) DO UPDATE SET commit = EXCLUDED.commit, files = EXCLUDED.files, hash = EXCLUDED.hash`,
        [pgTextSafe(bundle.packId), pgTextSafe(bundle.commit), pgJsonText(bundle.files), pgTextSafe(bundle.hash)],
      );
    },
    async delete(packId) {
      await q(`DELETE FROM skill_bundles WHERE tenant_id = ${TENANT} AND pack_id = $1`, [packId]);
    },
    close,
  };
}
