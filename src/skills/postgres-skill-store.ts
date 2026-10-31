import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { tsPrefixQuery } from "../sessions/entry-search.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import type { ScopeId } from "../types.ts";
import { pgJsonText, pgTextSafe } from "../util/text.ts";
import { createPostgresSkillBundleStore, type SkillBundleStore } from "./skill-bundle-store.ts";
import { createPostgresSkillPackStore, type SkillPackStore } from "./skill-pack-store.ts";
import {
  skillStore,
  type Skill,
  type SkillFile,
  type SkillRows,
  type SkillStore,
  type SkillStoreOptions,
} from "./skill-store.ts";

const STATUSES = "'draft', 'reviewed', 'published', 'archived'";
const TEXT_ARRAY = (path: string) =>
  `CASE WHEN jsonb_typeof(${path}) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${path})) ELSE '{}' END`;
const PACK_COMPLETE = ["packId", "commit", "upstreamName"]
  .map((field) => `json->'pack'->>'${field}' IS NOT NULL`)
  .join(" AND ");
const MILLIS = (field: string) => `round((json->>'${field}')::numeric)::bigint`;
const SEARCH_VECTOR = `to_tsvector('simple', name || ' ' || description)`;

const SKILLS_MIGRATION = typedTableMigration({
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
    files: "CASE WHEN jsonb_typeof(json->'manifest'->'files') = 'array' THEN json->'manifest'->'files' END",
    signature: "COALESCE(json->>'signature', '')",
    status: `CASE WHEN json->>'status' IN (${STATUSES}) THEN json->>'status' ELSE 'draft' END`,
    created_by: "COALESCE(json->>'createdBy', '')",
    version: "COALESCE(round((json->>'version')::numeric)::integer, 1)",
    granted_capabilities: TEXT_ARRAY("json->'grantedCapabilities'"),
    approvals: TEXT_ARRAY("json->'approvals'"),
    created_at: MILLIS("createdAt"),
    updated_at: MILLIS("updatedAt"),
    last_used_at: MILLIS("lastUsedAt"),
    pack_id: `CASE WHEN ${PACK_COMPLETE} THEN json->'pack'->>'packId' END`,
    pack_commit: `CASE WHEN ${PACK_COMPLETE} THEN json->'pack'->>'commit' END`,
    pack_upstream_name: `CASE WHEN ${PACK_COMPLETE} THEN json->'pack'->>'upstreamName' END`,
  },
  where: "json->>'scopeId' IS NOT NULL AND json->'manifest'->>'name' IS NOT NULL",
  indexes: [
    "CREATE INDEX skills_by_scope_name ON skills(tenant_id, scope_id, name, status)",
    "CREATE INDEX skills_by_name ON skills(tenant_id, name, status)",
    "CREATE INDEX skills_by_pack ON skills(tenant_id, pack_id) WHERE pack_id IS NOT NULL",
    "CREATE INDEX skills_by_creator ON skills(tenant_id, created_by)",
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
    pgTextSafe(skill.id),
    pgTextSafe(skill.scopeId),
    pgTextSafe(manifest.name),
    pgTextSafe(manifest.description),
    manifest.requiredCapabilities.map(pgTextSafe),
    pgTextSafe(manifest.body),
    manifest.files ? pgJsonText(manifest.files) : null,
    pgTextSafe(skill.signature),
    skill.status,
    pgTextSafe(skill.createdBy),
    skill.version,
    skill.grantedCapabilities.map(pgTextSafe),
    skill.approvals.map(pgTextSafe),
    skill.createdAt ?? null,
    skill.updatedAt ?? null,
    skill.lastUsedAt ?? null,
    skill.pack ? pgTextSafe(skill.pack.packId) : null,
    skill.pack ? pgTextSafe(skill.pack.commit) : null,
    skill.pack ? pgTextSafe(skill.pack.upstreamName) : null,
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
    archivedFor: (scopes, creators) =>
      select("status = 'archived' AND (lower(scope_id) = ANY($1::text[]) OR lower(created_by) = ANY($2::text[]))", [
        scopes.map((scope) => scope.toLowerCase()),
        creators.map((creator) => creator.toLowerCase()),
      ]),
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

export function createPostgresSkillStore(connectionString: string, opts: SkillStoreOptions): SkillStore {
  return skillStore(createPostgresSkillRows(connectionString), opts);
}

export function createSkillStores(
  databaseUrl: string,
  opts: SkillStoreOptions,
): { skills: SkillStore; skillPacks: SkillPackStore; skillBundles: SkillBundleStore } {
  return {
    skills: createPostgresSkillStore(databaseUrl, opts),
    skillPacks: createPostgresSkillPackStore(databaseUrl),
    skillBundles: createPostgresSkillBundleStore(databaseUrl),
  };
}
