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

const TRIGGER_FIELDS = `owner_scope_id AS "ownerScopeId", created_by AS "createdBy", owner, destination`;

export const CRON_SEARCH_TITLE = "coalesce(title, '')";
export const CRON_SEARCH_DESCRIPTION = "coalesce(action, '') || ' ' || coalesce(message, '')";
export const WEBHOOK_SEARCH_TITLE = "coalesce(action, '')";
export const WEBHOOK_SEARCH_DESCRIPTION = "coalesce(verification->>'scheme', '')";

const sources: Record<IndexedResourceKind, { table: string; title: string; description: string; fields: string }> = {
  crons: {
    table: "crons",
    title: CRON_SEARCH_TITLE,
    description: CRON_SEARCH_DESCRIPTION,
    fields: TRIGGER_FIELDS,
  },
  webhooks: {
    table: "webhooks",
    title: WEBHOOK_SEARCH_TITLE,
    description: WEBHOOK_SEARCH_DESCRIPTION,
    fields: TRIGGER_FIELDS,
  },
  deploys: {
    table: "deployments",
    title: "coalesce(display_name, name, '')",
    description: "coalesce(name, '')",
    fields: `owner_scope_id AS "ownerScopeId", created_in_scope AS "createdInScope",
        created_by AS "createdBy", status`,
  },
};

export function createPostgresResourceSearch(pg: PgPool): ResourceSearchStore {
  return {
    async search(kind, query, limit) {
      const terms = tsPrefixQuery(query);
      if (!terms) return [];
      const source = sources[kind];
      const vector = `to_tsvector('simple', ${source.title} || ' ' || ${source.description})`;
      const rows = await pg.q(
        `SELECT id, ${source.title} AS title, ${source.description} AS description, ${source.fields}
        FROM ${source.table} WHERE tenant_id = ${TENANT} AND ${vector} @@ to_tsquery('simple', $1)
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
