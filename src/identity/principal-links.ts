import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPgPool, tenantCols, withPgTransaction } from "../persistence/pg-pool.ts";
import type { PgMigrationDefinition } from "../persistence/pg-migrations.ts";
import { cols, columnName, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { foldPrincipalId, type PrincipalLinkResolver } from "../directory/person.ts";
import { perTenant } from "../tenant.ts";
import { personalScope, type ScopeId } from "../types.ts";
import { mergePrincipalData } from "./principal-merge.ts";

export interface PrincipalLink {
  principalId: string;
  canonicalId: string;
  linkedBy: string;
  createdAt: number;
}

interface PrincipalLinkInput {
  principalId: unknown;
  canonicalId: unknown;
  linkedBy: string;
}

export class PrincipalLinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PrincipalLinkService extends PrincipalLinkResolver {
  list(): Promise<PrincipalLink[]>;
  link(input: PrincipalLinkInput): Promise<PrincipalLink>;
  unlink(principalId: string): Promise<PrincipalLink | null>;
  refresh(): Promise<void>;
}

const PRINCIPAL_LINKS_MIGRATION = mapToTableMigration("identity/principal-links/0001-typed", {
  table: "principal_links",
  key: "id",
  columns: cols(`principalId text!, canonicalId text!, evidence text!, linkedBy text!, createdAt bigint!`),
});

const PRINCIPAL_LINKS: TableSpec = {
  table: "principal_links",
  key: "id",
  columns: cols(`principalId text!, canonicalId text!, linkedBy text!, createdAt bigint!`),
};

const EVIDENCE_OPTIONAL: PgMigrationDefinition = {
  id: "identity/principal-links/0002-evidence-optional",
  statements: ["SET LOCAL lock_timeout = '3s'", "ALTER TABLE principal_links ALTER COLUMN evidence DROP NOT NULL"],
};

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createPrincipalLinkService(
  databaseUrl: string,
  lock: AdvisoryLock,
  opts: { refreshScopes?: (ids: ScopeId[]) => Promise<void> } = {},
): PrincipalLinkService {
  const db = createPgPool(databaseUrl, [PRINCIPAL_LINKS_MIGRATION, EVIDENCE_OPTIONAL]);
  const table = typedTable<PrincipalLink>(db, PRINCIPAL_LINKS);
  const { codec } = table;
  const insertLink = `INSERT INTO principal_links (${codec.columns}) VALUES (${codec.placeholders})
    ON CONFLICT (${tenantCols(columnName("id"))}) DO NOTHING RETURNING ${codec.columns}`;
  const linkFor = `SELECT ${codec.columns} FROM principal_links WHERE id = $1`;
  const state = perTenant(() => ({
    byAlias: new Map<string, PrincipalLink>(),
    byCanonical: new Map<string, PrincipalLink[]>(),
    refreshP: null as Promise<void> | null,
  }));

  function index(rows: PrincipalLink[]): void {
    const { byAlias, byCanonical } = state();
    byAlias.clear();
    byCanonical.clear();
    for (const row of rows) {
      byAlias.set(foldPrincipalId(row.principalId), row);
      const key = foldPrincipalId(row.canonicalId);
      const list = byCanonical.get(key) ?? [];
      list.push(row);
      byCanonical.set(key, list);
    }
  }

  async function refresh(): Promise<void> {
    const s = state();
    while (s.refreshP) await s.refreshP;
    s.refreshP = table
      .all()
      .then(index)
      .finally(() => {
        s.refreshP = null;
      });
    return s.refreshP;
  }

  return {
    canonical(key) {
      return state().byAlias.get(key)?.canonicalId;
    },
    aliases(key) {
      return (state().byCanonical.get(key) ?? []).map((row) => row.principalId);
    },
    refresh,
    async list() {
      await refresh();
      return [...state().byAlias.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.principalId.localeCompare(b.principalId),
      );
    },
    async link(input) {
      return lock.withLock("principal-links", async () => {
        if (!validId(input.principalId) || !validId(input.canonicalId))
          throw new PrincipalLinkError(400, "principalId and canonicalId must be non-empty ids");
        const principalId = input.principalId.trim();
        const canonicalId = foldPrincipalId(input.canonicalId);
        const aliasKey = foldPrincipalId(principalId);
        if (aliasKey === canonicalId) throw new PrincipalLinkError(400, "a principal cannot be linked to itself");
        await refresh();
        const { byAlias, byCanonical } = state();
        const existing = byAlias.get(aliasKey);
        if (existing) {
          if (foldPrincipalId(existing.canonicalId) === canonicalId) return existing;
          throw new PrincipalLinkError(409, `${principalId} is already linked to ${existing.canonicalId}`);
        }
        const canonicalIsAlias = byAlias.get(canonicalId);
        if (canonicalIsAlias)
          throw new PrincipalLinkError(
            400,
            `${canonicalId} is itself linked to ${canonicalIsAlias.canonicalId}; link to that principal instead`,
          );
        if (byCanonical.has(aliasKey))
          throw new PrincipalLinkError(
            400,
            `${principalId} is the canonical principal of other links; unlink those first`,
          );
        const link: PrincipalLink = { principalId, canonicalId, linkedBy: input.linkedBy, createdAt: Date.now() };
        const stored = await withPgTransaction(await db.pool(), async (client) => {
          const inserted = (await client.query(insertLink, codec.values(aliasKey, link))).rows[0];
          if (inserted) {
            await mergePrincipalData(client, principalId, canonicalId);
            return codec.row(inserted);
          }
          return codec.row((await client.query(linkFor, [aliasKey])).rows[0]!);
        });
        await refresh();
        if (foldPrincipalId(stored.canonicalId) !== canonicalId)
          throw new PrincipalLinkError(409, `${principalId} is already linked to ${stored.canonicalId}`);
        await opts.refreshScopes?.([personalScope(principalId), personalScope(canonicalId)]);
        return stored;
      });
    },
    async unlink(principalId) {
      return lock.withLock("principal-links", async () => {
        const row = await table.take(foldPrincipalId(principalId));
        await refresh();
        return row;
      });
    },
  };
}
