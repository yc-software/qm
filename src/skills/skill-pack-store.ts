import { randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { pgJsonText, pgTextSafe } from "../util/text.ts";
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
  close?(): Promise<void>;
}

const IMPORT_COMPLETE =
  "json->'lastImport'->>'at' IS NOT NULL AND json->'lastImport'->>'commit' IS NOT NULL AND json->'lastImport'->>'status' IN ('ok', 'error')";

export const SKILL_PACKS_MIGRATION = typedTableMigration({
  table: "skill_packs",
  columns: [
    "id TEXT NOT NULL",
    "kind TEXT NOT NULL CHECK (kind = 'git')",
    "url TEXT NOT NULL",
    "ref TEXT NOT NULL",
    "sync_mode TEXT NOT NULL CHECK (sync_mode IN ('pinned', 'tracked'))",
    "trust_tier TEXT NOT NULL CHECK (trust_tier IN ('internal', 'third-party'))",
    "config JSONB",
    "target_scope_id TEXT NOT NULL",
    "subset TEXT[]",
    "auth_credential_slug TEXT",
    "created_by TEXT NOT NULL",
    "created_at BIGINT NOT NULL",
    "last_import_at BIGINT",
    "last_import_commit TEXT",
    "last_import_status TEXT CHECK (last_import_status IN ('ok', 'error'))",
    "last_import_error TEXT",
    "last_import_counts JSONB",
    "update_available BOOLEAN",
    "available INTEGER",
  ],
  constraints: [
    "CHECK ((last_import_at IS NULL) = (last_import_commit IS NULL) AND (last_import_at IS NULL) = (last_import_status IS NULL))",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    kind: "'git'",
    url: "json->>'url'",
    ref: "json->>'ref'",
    sync_mode: "CASE WHEN json->>'syncMode' = 'tracked' THEN 'tracked' ELSE 'pinned' END",
    trust_tier: "CASE WHEN json->>'trustTier' = 'internal' THEN 'internal' ELSE 'third-party' END",
    config: "NULLIF(json->'config', 'null'::jsonb)",
    target_scope_id: "json->>'targetScopeId'",
    subset:
      "CASE WHEN jsonb_typeof(json->'subset') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(json->'subset')) END",
    auth_credential_slug: "json->>'authCredentialSlug'",
    created_by: "COALESCE(json->>'createdBy', '')",
    created_at: "COALESCE(round((json->>'createdAt')::numeric)::bigint, 0)",
    last_import_at: `CASE WHEN ${IMPORT_COMPLETE} THEN round((json->'lastImport'->>'at')::numeric)::bigint END`,
    last_import_commit: `CASE WHEN ${IMPORT_COMPLETE} THEN json->'lastImport'->>'commit' END`,
    last_import_status: `CASE WHEN ${IMPORT_COMPLETE} THEN json->'lastImport'->>'status' END`,
    last_import_error: `CASE WHEN ${IMPORT_COMPLETE} THEN json->'lastImport'->>'error' END`,
    last_import_counts: `CASE WHEN ${IMPORT_COMPLETE} THEN NULLIF(json->'lastImport'->'counts', 'null'::jsonb) END`,
    update_available: "(json->>'updateAvailable')::boolean",
    available: "round((json->>'available')::numeric)::integer",
  },
  where: "json->>'url' IS NOT NULL AND json->>'ref' IS NOT NULL AND json->>'targetScopeId' IS NOT NULL",
});

function safeText(value: string | undefined): string | null {
  return value === undefined ? null : pgTextSafe(value);
}

const PACK_COLUMNS: { [K in keyof SkillPack]-?: (pack: Partial<SkillPack>) => Record<string, unknown> } = {
  id: (p) => ({ id: p.id }),
  kind: (p) => ({ kind: p.kind }),
  url: (p) => ({ url: safeText(p.url) }),
  ref: (p) => ({ ref: safeText(p.ref) }),
  syncMode: (p) => ({ sync_mode: p.syncMode }),
  trustTier: (p) => ({ trust_tier: p.trustTier }),
  config: (p) => ({ config: p.config ? pgJsonText(p.config) : null }),
  targetScopeId: (p) => ({ target_scope_id: safeText(p.targetScopeId) }),
  subset: (p) => ({ subset: p.subset === "all" || p.subset === undefined ? null : p.subset.map(pgTextSafe) }),
  authCredentialSlug: (p) => ({ auth_credential_slug: safeText(p.authCredentialSlug) }),
  createdBy: (p) => ({ created_by: safeText(p.createdBy) }),
  createdAt: (p) => ({ created_at: p.createdAt }),
  lastImport: ({ lastImport: i }) => ({
    last_import_at: i?.at ?? null,
    last_import_commit: safeText(i?.commit),
    last_import_status: i?.status ?? null,
    last_import_error: safeText(i?.error),
    last_import_counts: i?.counts ? pgJsonText(i.counts) : null,
  }),
  updateAvailable: (p) => ({ update_available: p.updateAvailable ?? null }),
  available: (p) => ({ available: p.available ?? null }),
};

function packColumns(pack: Partial<SkillPack>): Record<string, unknown> {
  return Object.assign(
    {},
    ...(Object.keys(pack) as Array<keyof SkillPack>)
      .filter((key) => key in PACK_COLUMNS)
      .map((key) => PACK_COLUMNS[key](pack)),
  );
}

function packFromRow(row: Record<string, unknown>): SkillPack {
  return {
    id: String(row.id),
    kind: row.kind as PackKind,
    url: String(row.url),
    ref: String(row.ref),
    syncMode: row.sync_mode as SyncMode,
    trustTier: row.trust_tier as TrustTier,
    ...(row.config != null ? { config: row.config as PackConfig } : {}),
    targetScopeId: row.target_scope_id as ScopeId,
    subset: row.subset == null ? "all" : (row.subset as string[]),
    ...(row.auth_credential_slug != null ? { authCredentialSlug: String(row.auth_credential_slug) } : {}),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    ...(row.last_import_at != null
      ? {
          lastImport: {
            at: Number(row.last_import_at),
            commit: String(row.last_import_commit),
            status: row.last_import_status as ImportRecord["status"],
            ...(row.last_import_error != null ? { error: String(row.last_import_error) } : {}),
            ...(row.last_import_counts != null ? { counts: row.last_import_counts as Record<string, number> } : {}),
          },
        }
      : {}),
    ...(row.update_available != null ? { updateAvailable: Boolean(row.update_available) } : {}),
    ...(row.available != null ? { available: Number(row.available) } : {}),
  };
}

export function createPostgresSkillPackStore(
  connectionString: string,
  opts: { now?: () => number } = {},
): SkillPackStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, SKILL_PACKS_MIGRATION]);
  const now = opts.now ?? (() => Date.now());
  const update = async (id: string, patch: Partial<SkillPack>): Promise<SkillPack | null> => {
    const columns = Object.entries(packColumns(patch)).filter(([column]) => column !== "id" && column !== "created_at");
    if (!columns.length) {
      const rows = await q(`SELECT * FROM skill_packs WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
      return rows[0] ? packFromRow(rows[0]) : null;
    }
    const rows = await q(
      `UPDATE skill_packs SET ${columns.map(([column], i) => `${column} = $${i + 2}`).join(", ")}
        WHERE tenant_id = ${TENANT} AND id = $1 RETURNING *`,
      [id, ...columns.map(([, value]) => value)],
    );
    return rows[0] ? packFromRow(rows[0]) : null;
  };
  return {
    async create(input) {
      const pack: SkillPack = { ...input, id: randomUUID(), createdAt: now() };
      const columns = Object.entries(packColumns(pack));
      await q(
        `INSERT INTO skill_packs(${columns.map(([column]) => column).join(", ")})
          VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        columns.map(([, value]) => value),
      );
      return pack;
    },
    async get(id) {
      const rows = await q(`SELECT * FROM skill_packs WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
      return rows[0] ? packFromRow(rows[0]) : null;
    },
    async list() {
      return (await q(`SELECT * FROM skill_packs WHERE tenant_id = ${TENANT} ORDER BY id`)).map(packFromRow);
    },
    async update(id, patch) {
      const updated = await update(id, patch);
      if (!updated) throw new Error(`unknown skill pack: ${id}`);
      return updated;
    },
    async remove(id) {
      await q(`DELETE FROM skill_packs WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
    },
    async recordImport(id, result) {
      await update(id, { lastImport: result });
    },
    close,
  };
}
