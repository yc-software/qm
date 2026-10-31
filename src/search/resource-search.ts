import type { PgPool } from "../persistence/pg-pool.ts";
import { searchSnippet, searchTerms, tsPrefixQuery } from "../sessions/entry-search.ts";
import type { ScopeId } from "../types.ts";
import type { Cron } from "../triggers/types.ts";
import { TENANT } from "../tenants/migrations.ts";

export type ResourceKind = "skills" | "crons" | "deploys" | "webhooks";
type IndexedResourceKind = Exclude<ResourceKind, "skills">;
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
  search(kind: IndexedResourceKind, query: string, limit: number): Promise<ResourceCandidate[]>;
}

const JSON_FIELDS = `json->>'scopeId' AS "scopeId", json->>'ownerScopeId' AS "ownerScopeId",
        json->>'createdInScope' AS "createdInScope", json->>'createdBy' AS "createdBy",
        json->>'owner' AS owner, json->>'status' AS status,
        json->'members' AS members, json->'destination' AS destination`;

const TRIGGER_FIELDS = `owner_scope_id AS "ownerScopeId", created_by AS "createdBy", owner, destination`;

const jsonSources = {
  deploys: {
    table: "deployments",
    title: "coalesce(json->>'displayName', json->>'name', '')",
    description: "coalesce(json->>'name', '')",
  },
} satisfies Record<Exclude<ResourceKind, "skills" | "crons" | "webhooks">, { table: string; title: string; description: string }>;

export const CRON_SEARCH_TITLE = "coalesce(title, '')";
export const CRON_SEARCH_DESCRIPTION = "coalesce(action, '') || ' ' || coalesce(message, '')";
export const WEBHOOK_SEARCH_TITLE = "coalesce(action, '')";
export const WEBHOOK_SEARCH_DESCRIPTION = "coalesce(verification->>'scheme', '')";

const sources: Record<
  IndexedResourceKind,
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
    ],
  }));
  for (const migration of migrations) pg.registerMigration(migration);
  const ready = new Map<IndexedResourceKind, Promise<void>>();
  const ensure = (kind: IndexedResourceKind): Promise<void> => {
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
