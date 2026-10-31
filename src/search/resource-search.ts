import type { SkillSummary } from "../skills/skill-store.ts";
import type { PgPool } from "../persistence/pg-pool.ts";
import { matchesSearchTerms, searchSnippet, searchTerms, tsPrefixQuery } from "../sessions/entry-search.ts";
import type { Cron, ScopeId } from "../types.ts";
import { TENANT } from "../tenants/migrations.ts";

export type ResourceKind = "skills" | "crons" | "deploys" | "webhooks";
export interface ResourceCandidate {
  id: string;
  title: string;
  description: string;
  scopeId: ScopeId;
  ownerScopeId: ScopeId;
  createdInScope?: ScopeId;
  createdBy: string;
  owner: string;
  status?: string;
  destination?: Cron["destination"];
}
export interface ResourceSearchHit {
  id: string;
  kind: ResourceKind | "contexts";
  title: string;
  snippet: string;
}
export interface ResourceSearchStore {
  skillMetadata(names: readonly string[]): Promise<{ skills: SkillSummary[]; homes: ScopeId[] }>;
  search(kind: ResourceKind, query: string, limit: number): Promise<ResourceCandidate[]>;
}

const JSON_FIELDS = `json->>'scopeId' AS "scopeId", json->>'ownerScopeId' AS "ownerScopeId",
        json->>'createdInScope' AS "createdInScope", json->>'createdBy' AS "createdBy",
        json->>'owner' AS owner, json->>'status' AS status,
        json->'members' AS members, json->'destination' AS destination`;

const TRIGGER_FIELDS = `owner_scope_id AS "ownerScopeId", created_by AS "createdBy", owner, destination`;

const jsonSources = {
  skills: {
    table: "skills",
    title: "coalesce(json->'manifest'->>'name', '')",
    description: "coalesce(json->'manifest'->>'description', '')",
  },
  deploys: {
    table: "deployments",
    title: "coalesce(json->>'displayName', json->>'name', '')",
    description: "coalesce(json->>'name', '')",
  },
} satisfies Record<Exclude<ResourceKind, "crons" | "webhooks">, { table: string; title: string; description: string }>;

export const CRON_SEARCH_TITLE = "coalesce(title, '')";
export const CRON_SEARCH_DESCRIPTION = "coalesce(action, '') || ' ' || coalesce(message, '')";
export const WEBHOOK_SEARCH_TITLE = "coalesce(action, '')";
export const WEBHOOK_SEARCH_DESCRIPTION = "coalesce(verification->>'scheme', '')";

const sources: Record<
  ResourceKind,
  { table: string; title: string; description: string; fields?: string; where?: string }
> = {
  ...jsonSources,
  crons: {
    table: "crons",
    title: CRON_SEARCH_TITLE,
    description: CRON_SEARCH_DESCRIPTION,
    fields: TRIGGER_FIELDS,
    where: `tenant_id = ${TENANT}`,
  },
  webhooks: {
    table: "webhooks",
    title: WEBHOOK_SEARCH_TITLE,
    description: WEBHOOK_SEARCH_DESCRIPTION,
    fields: TRIGGER_FIELDS,
    where: `tenant_id = ${TENANT}`,
  },
};

export function createPostgresResourceSearch(pg: PgPool): ResourceSearchStore {
  const migrations = Object.entries(jsonSources).map(([kind, source]) => ({
    id: `resource-search/${kind}/0001`,
    statements: [
      "SET LOCAL lock_timeout = '2s'",
      "SET LOCAL statement_timeout = '15s'",
      `CREATE TABLE IF NOT EXISTS ${source.table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${source.table}_resource_search_gin ON ${source.table} USING GIN (to_tsvector('simple', ${source.title} || ' ' || ${source.description}))`,
      ...(kind === "skills"
        ? ["CREATE INDEX IF NOT EXISTS skills_resource_name_idx ON skills ((json->'manifest'->>'name'))"]
        : []),
    ],
  }));
  for (const migration of migrations) pg.registerMigration(migration);
  const ready = new Map<ResourceKind, Promise<void>>();
  const ensure = (kind: ResourceKind): Promise<void> => {
    let pending = ready.get(kind);
    if (!pending) {
      const migration = migrations[Object.keys(jsonSources).indexOf(kind)];
      if (!migration) return Promise.resolve();
      pending = pg.migrate(migration).catch((error) => {
        ready.delete(kind);
        throw error;
      });
      ready.set(kind, pending);
    }
    return pending;
  };
  return {
    async skillMetadata(names) {
      await ensure("skills");
      const [rows, homes] = await Promise.all([
        pg.q(
          "SELECT id, json->>'scopeId' AS scope, json->>'status' AS status, json->'manifest'->>'name' AS name FROM skills WHERE json->'manifest'->>'name' = ANY($1::text[]) ORDER BY id",
          [[...names]],
        ),
        pg.q("SELECT json->>'scopeId' AS scope FROM skills GROUP BY json->>'scopeId' ORDER BY min(id)"),
      ]);
      return {
        skills: rows.map((r) => ({
          id: String(r.id),
          scopeId: r.scope as ScopeId,
          status: r.status as SkillSummary["status"],
          manifest: { name: String(r.name) },
        })),
        homes: homes.map((r) => r.scope as ScopeId),
      };
    },
    async search(kind, query, limit) {
      const terms = tsPrefixQuery(query);
      if (!terms) return [];
      const source = sources[kind];
      await ensure(kind);
      const vector = `to_tsvector('simple', ${source.title} || ' ' || ${source.description})`;
      const rows = await pg.q(
        `SELECT id, ${source.title} AS title, ${source.description} AS description, ${source.fields ?? JSON_FIELDS}
        FROM ${source.table} WHERE ${source.where ? `${source.where} AND ` : ""}${vector} @@ to_tsquery('simple', $1)
        ORDER BY ts_rank(${vector}, to_tsquery('simple', $1)) DESC, id
        LIMIT $2`,
        [terms, limit],
      );
      return rows as unknown as ResourceCandidate[];
    },
  };
}

export function createMemoryResourceSearch(
  list: (kind: ResourceKind) => Promise<ResourceCandidate[]>,
): ResourceSearchStore {
  return {
    async skillMetadata(names) {
      const rows = await list("skills");
      return {
        homes: rows.map((r) => r.scopeId),
        skills: rows
          .filter((r) => names.includes(r.title))
          .map((r) => ({
            id: r.id,
            scopeId: r.scopeId,
            status: r.status as SkillSummary["status"],
            manifest: { name: r.title },
          })),
      };
    },
    async search(kind, query, limit) {
      const terms = searchTerms(query);
      return (await list(kind))
        .filter((row) => matchesSearchTerms(`${row.title} ${row.description}`, terms))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit);
    },
  };
}

export function resourceHit(
  kind: ResourceSearchHit["kind"],
  row: Pick<ResourceCandidate, "id" | "title" | "description">,
  query: string,
): ResourceSearchHit {
  return {
    id: row.id,
    kind,
    title: searchSnippet(row.title || row.description || row.id, [], 120),
    snippet: searchSnippet(row.description, searchTerms(query), 240),
  };
}
