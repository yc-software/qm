import type { PgPool } from "../persistence/pg-pool.ts";
import { matchesSearchTerms, searchSnippet, searchTerms, tsPrefixQuery } from "../sessions/entry-search.ts";
import type { Cron, ScopeId } from "../types.ts";

export type ResourceKind = "skills" | "crons" | "deploys" | "webhooks";
export type IndexedResourceKind = Exclude<ResourceKind, "skills">;
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

const sources = {
  crons: {
    table: "crons",
    title: "coalesce(json->>'title', '')",
    description: "coalesce(json->>'action', '') || ' ' || coalesce(json->>'message', '')",
  },
  deploys: {
    table: "deployments",
    title: "coalesce(json->>'displayName', json->>'name', '')",
    description: "coalesce(json->>'name', '')",
  },
  webhooks: {
    table: "webhooks",
    title: "coalesce(json->>'action', '')",
    description: "coalesce(json->'verification'->>'scheme', '')",
  },
} satisfies Record<IndexedResourceKind, { table: string; title: string; description: string }>;

export function createPostgresResourceSearch(pg: PgPool): ResourceSearchStore {
  const migrations = Object.entries(sources).map(([kind, source]) => ({
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
      pending = pg.migrate(migrations[Object.keys(sources).indexOf(kind)]!).catch((error) => {
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
        `SELECT id, ${source.title} AS title, ${source.description} AS description,
        json->>'scopeId' AS "scopeId", json->>'ownerScopeId' AS "ownerScopeId",
        json->>'createdInScope' AS "createdInScope", json->>'createdBy' AS "createdBy",
        json->>'owner' AS owner, json->>'status' AS status,
        json->'members' AS members, json->'destination' AS destination
        FROM ${source.table} WHERE ${vector} @@ to_tsquery('simple', $1)
        ORDER BY ts_rank(${vector}, to_tsquery('simple', $1)) DESC, id
        LIMIT $2`,
        [terms, limit],
      );
      return rows as unknown as ResourceCandidate[];
    },
  };
}

export function createMemoryResourceSearch(
  list: (kind: IndexedResourceKind) => Promise<ResourceCandidate[]>,
): ResourceSearchStore {
  return {
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
