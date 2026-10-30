import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { tsPrefixQuery } from "../sessions/entry-search.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import type { ScopeId } from "../types.ts";
import { pgTextSafe } from "../util/text.ts";
import { createPostgresSkillBundleStore, createSkillBundleStore, type SkillBundleStore } from "./skill-bundle-store.ts";
import { createPostgresSkillPackStore, createSkillPackStore, type SkillPackStore } from "./skill-pack-store.ts";
import {
  createSkillStore,
  skillStore,
  type Skill,
  type SkillFile,
  type SkillRows,
  type SkillStore,
  type SkillStoreOptions,
} from "./skill-store.ts";

const STATUSES = "'draft', 'reviewed', 'published', 'archived'";
const TEXT_ARRAY = (path: string) => `ARRAY(SELECT jsonb_array_elements_text(COALESCE(${path}, '[]'::jsonb)))`;
const ARRAY_OR_ABSENT = (path: string) => `COALESCE(jsonb_typeof(${path}), 'array') = 'array'`;
const MILLIS = (field: string) => `round((json->>'${field}')::numeric)::bigint`;
const SEARCH_VECTOR = `to_tsvector('simple', name || ' ' || description)`;

export const SKILLS_MIGRATION = typedTableMigration({
  table: "skills",
  columns: [
    "id TEXT NOT NULL",
    "scope_id TEXT NOT NULL",
    "name TEXT NOT NULL",
    "description TEXT NOT NULL",
    "required_capabilities TEXT[] NOT NULL",
    "body TEXT NOT NULL",
    "files JSONB",
    "signature TEXT NOT NULL",
    `status TEXT NOT NULL CHECK (status IN (${STATUSES}))`,
    "created_by TEXT NOT NULL",
    "version INTEGER NOT NULL",
    "granted_capabilities TEXT[] NOT NULL",
    "approvals TEXT[] NOT NULL",
    "created_at BIGINT",
    "updated_at BIGINT",
    "last_used_at BIGINT",
    "pack_id TEXT",
    "pack_commit TEXT",
    "pack_upstream_name TEXT",
  ],
  constraints: [
    "CHECK ((pack_id IS NULL) = (pack_commit IS NULL) AND (pack_id IS NULL) = (pack_upstream_name IS NULL))",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    scope_id: "json->>'scopeId'",
    name: "json->'manifest'->>'name'",
    description: "COALESCE(json->'manifest'->>'description', '')",
    required_capabilities: TEXT_ARRAY("json->'manifest'->'requiredCapabilities'"),
    body: "COALESCE(json->'manifest'->>'body', '')",
    files: "NULLIF(json->'manifest'->'files', 'null'::jsonb)",
    signature: "COALESCE(json->>'signature', '')",
    status: "json->>'status'",
    created_by: "COALESCE(json->>'createdBy', '')",
    version: "COALESCE((json->>'version')::integer, 1)",
    granted_capabilities: TEXT_ARRAY("json->'grantedCapabilities'"),
    approvals: TEXT_ARRAY("json->'approvals'"),
    created_at: MILLIS("createdAt"),
    updated_at: MILLIS("updatedAt"),
    last_used_at: MILLIS("lastUsedAt"),
    pack_id: "json->'pack'->>'packId'",
    pack_commit: "json->'pack'->>'commit'",
    pack_upstream_name: "json->'pack'->>'upstreamName'",
  },
  where: [
    "json->>'scopeId' IS NOT NULL",
    "json->'manifest'->>'name' IS NOT NULL",
    `json->>'status' IN (${STATUSES})`,
    ARRAY_OR_ABSENT("json->'manifest'->'requiredCapabilities'"),
    ARRAY_OR_ABSENT("json->'grantedCapabilities'"),
    ARRAY_OR_ABSENT("json->'approvals'"),
    `(json->'pack' IS NULL OR (json->'pack'->>'packId' IS NOT NULL AND json->'pack'->>'commit' IS NOT NULL AND json->'pack'->>'upstreamName' IS NOT NULL))`,
  ].join(" AND "),
  indexes: [
    "CREATE INDEX skills_by_scope_name ON skills(tenant_id, scope_id, name, status)",
    "CREATE INDEX skills_by_name ON skills(tenant_id, name, status)",
    "CREATE INDEX skills_by_pack ON skills(tenant_id, pack_id) WHERE pack_id IS NOT NULL",
    "CREATE INDEX skills_by_creator ON skills(tenant_id, created_by)",
    `CREATE INDEX skills_search ON skills USING GIN (${SEARCH_VECTOR})`,
  ],
});

const COLUMNS = [
  "id",
  "scope_id",
  "name",
  "description",
  "required_capabilities",
  "body",
  "files",
  "signature",
  "status",
  "created_by",
  "version",
  "granted_capabilities",
  "approvals",
  "created_at",
  "updated_at",
  "last_used_at",
  "pack_id",
  "pack_commit",
  "pack_upstream_name",
];

function millis(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}

function fromRow(row: Record<string, unknown>): Skill {
  const createdAt = millis(row.created_at);
  const updatedAt = millis(row.updated_at);
  const lastUsedAt = millis(row.last_used_at);
  return {
    id: String(row.id),
    scopeId: row.scope_id as ScopeId,
    manifest: {
      name: String(row.name),
      description: String(row.description),
      requiredCapabilities: row.required_capabilities as string[],
      body: String(row.body),
      ...(row.files != null ? { files: row.files as SkillFile[] } : {}),
    },
    signature: String(row.signature),
    status: row.status as Skill["status"],
    createdBy: String(row.created_by),
    version: Number(row.version),
    grantedCapabilities: row.granted_capabilities as string[],
    approvals: row.approvals as string[],
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    ...(row.pack_id != null
      ? {
          pack: {
            packId: String(row.pack_id),
            commit: String(row.pack_commit),
            upstreamName: String(row.pack_upstream_name),
          },
        }
      : {}),
  };
}

function toRow(skill: Skill): unknown[] {
  const { manifest } = skill;
  return [
    skill.id,
    skill.scopeId,
    manifest.name,
    pgTextSafe(manifest.description),
    manifest.requiredCapabilities,
    pgTextSafe(manifest.body),
    manifest.files ? jsonbStringify(manifest.files) : null,
    skill.signature,
    skill.status,
    skill.createdBy,
    skill.version,
    skill.grantedCapabilities,
    skill.approvals,
    skill.createdAt ?? null,
    skill.updatedAt ?? null,
    skill.lastUsedAt ?? null,
    skill.pack?.packId ?? null,
    skill.pack?.commit ?? null,
    skill.pack?.upstreamName ?? null,
  ];
}

const SAVE = `INSERT INTO skills(${COLUMNS.join(", ")})
  VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})
  ON CONFLICT (tenant_id, id) DO UPDATE SET ${COLUMNS.slice(1)
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ")}`;

export function createPostgresSkillRows(connectionString: string): SkillRows {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, SKILLS_MIGRATION]);
  const select = async (where: string, params: unknown[] = []): Promise<Skill[]> =>
    (await q(`SELECT * FROM skills WHERE tenant_id = ${TENANT} AND ${where} ORDER BY id`, params)).map(fromRow);
  return {
    async get(id) {
      return (await select("id = $1", [id]))[0] ?? null;
    },
    async save(skill) {
      await q(SAVE, toRow(skill));
    },
    async delete(id) {
      await q(`DELETE FROM skills WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
    },
    async touch(id, at) {
      await q(`UPDATE skills SET last_used_at = $2 WHERE tenant_id = ${TENANT} AND id = $1`, [id, at]);
    },
    inScopes: (scopes, name) =>
      name === undefined
        ? select("scope_id = ANY($1::text[])", [[...scopes]])
        : select("scope_id = ANY($1::text[]) AND name = $2", [[...scopes], name]),
    publishedNamed: (names) => select("name = ANY($1::text[]) AND status = 'published'", [[...names]]),
    fromPacks: (packIds) => select("pack_id = ANY($1::text[])", [[...packIds]]),
    async activePackIds() {
      const found: Rows = await q(
        `SELECT DISTINCT pack_id FROM skills
          WHERE tenant_id = ${TENANT} AND pack_id IS NOT NULL AND status = 'published' ORDER BY pack_id`,
      );
      return found.map((row) => String(row.pack_id));
    },
    archivedFor: (scopes, createdBy) =>
      select("status = 'archived' AND (scope_id = ANY($1::text[]) OR created_by = $2)", [[...scopes], createdBy]),
    async search(query, limit) {
      const terms = tsPrefixQuery(query);
      if (!terms) return [];
      const found = await q(
        `SELECT * FROM skills
          WHERE tenant_id = ${TENANT} AND ${SEARCH_VECTOR} @@ to_tsquery('simple', $1)
          ORDER BY ts_rank(${SEARCH_VECTOR}, to_tsquery('simple', $1)) DESC, id
          LIMIT $2`,
        [terms, limit],
      );
      return found.map(fromRow);
    },
    listAll: () => select("TRUE"),
    close,
  };
}

export function createPostgresSkillStore(connectionString: string, opts: SkillStoreOptions = {}): SkillStore {
  return skillStore(createPostgresSkillRows(connectionString), opts);
}

export function createSkillStores(
  databaseUrl: string | undefined,
  opts: SkillStoreOptions,
): { skills: SkillStore; skillPacks: SkillPackStore; skillBundles: SkillBundleStore } {
  if (!databaseUrl) {
    return {
      skills: createSkillStore(opts),
      skillPacks: createSkillPackStore(),
      skillBundles: createSkillBundleStore(),
    };
  }
  return {
    skills: createPostgresSkillStore(databaseUrl, opts),
    skillPacks: createPostgresSkillPackStore(databaseUrl),
    skillBundles: createPostgresSkillBundleStore(databaseUrl),
  };
}
