import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { foldPrincipalId, type PrincipalLinkResolver } from "../directory/person.ts";
import { perTenant } from "../tenant.ts";

export interface PrincipalLink {
  principalId: string;
  canonicalId: string;
  evidence: string;
  linkedBy: string;
  createdAt: number;
}

interface PrincipalLinkInput {
  principalId: unknown;
  canonicalId: unknown;
  evidence: unknown;
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
  refresh(force?: boolean): Promise<void>;
}

const MAX_ID_LENGTH = 255;
const MAX_EVIDENCE_LENGTH = 500;
const REFRESH_TTL_MS = 10_000;

const PRINCIPAL_LINKS: TableSpec = {
  table: "principal_links",
  key: "id",
  columns: cols(`principalId text!, canonicalId text!, evidence text!, linkedBy text!, createdAt bigint!`),
};

const PRINCIPAL_LINKS_MIGRATION = mapToTableMigration("identity/principal-links/0001-typed", PRINCIPAL_LINKS);

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_ID_LENGTH;
}

export function createPrincipalLinkService(databaseUrl: string, lock: AdvisoryLock): PrincipalLinkService {
  const table = typedTable<PrincipalLink>(createPgPool(databaseUrl, [PRINCIPAL_LINKS_MIGRATION]), PRINCIPAL_LINKS);
  const state = perTenant(() => ({
    byAlias: new Map<string, PrincipalLink>(),
    byCanonical: new Map<string, PrincipalLink[]>(),
    refreshedAt: 0,
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

  async function refresh(force = false): Promise<void> {
    const s = state();
    if (s.refreshP && !force) return s.refreshP;
    while (s.refreshP) await s.refreshP;
    if (!force && Date.now() - s.refreshedAt < REFRESH_TTL_MS) return Promise.resolve();
    s.refreshP = table
      .all()
      .then(index)
      .then(() => {
        s.refreshedAt = Date.now();
      })
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
      await refresh(true);
      return [...state().byAlias.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.principalId.localeCompare(b.principalId),
      );
    },
    async link(input) {
      return lock.withLock("principal-links", async () => {
        if (!validId(input.principalId) || !validId(input.canonicalId))
          throw new PrincipalLinkError(
            400,
            `principalId and canonicalId must be non-empty ids of at most ${MAX_ID_LENGTH} characters`,
          );
        const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
        if (!evidence || evidence.length > MAX_EVIDENCE_LENGTH)
          throw new PrincipalLinkError(400, `evidence must say how the two identities were verified as one person`);
        const principalId = input.principalId.trim();
        const canonicalId = input.canonicalId.trim();
        const aliasKey = foldPrincipalId(principalId);
        const canonicalKey = foldPrincipalId(canonicalId);
        if (aliasKey === canonicalKey) throw new PrincipalLinkError(400, "a principal cannot be linked to itself");
        await refresh(true);
        const { byAlias, byCanonical } = state();
        const existing = byAlias.get(aliasKey);
        if (existing) {
          if (foldPrincipalId(existing.canonicalId) === canonicalKey) return existing;
          throw new PrincipalLinkError(409, `${principalId} is already linked to ${existing.canonicalId}`);
        }
        const canonicalIsAlias = byAlias.get(canonicalKey);
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
        const link: PrincipalLink = {
          principalId,
          canonicalId,
          evidence,
          linkedBy: input.linkedBy,
          createdAt: Date.now(),
        };
        const stored = await table.insertOrGet(aliasKey, link);
        await refresh(true);
        if (foldPrincipalId(stored.canonicalId) !== canonicalKey)
          throw new PrincipalLinkError(409, `${principalId} is already linked to ${stored.canonicalId}`);
        return stored;
      });
    },
    async unlink(principalId) {
      return lock.withLock("principal-links", async () => {
        const row = await table.take(foldPrincipalId(principalId));
        await refresh(true);
        return row;
      });
    },
  };
}
