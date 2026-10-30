import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { currentTenant } from "../tenants/context.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { foldPrincipalId, type PrincipalLinkResolver } from "../directory/person.ts";

export interface PrincipalLink {
  principalId: string;
  canonicalId: string;
  evidence: string;
  linkedBy: string;
  createdAt: number;
}

export interface PrincipalLinkStore {
  list(): Promise<PrincipalLink[]>;
  insertIfAbsent(link: PrincipalLink): Promise<PrincipalLink>;
  take(principalId: string): Promise<PrincipalLink | null>;
  close?(): Promise<void>;
}

const PRINCIPAL_LINKS_MIGRATION = typedTableMigration({
  table: "principal_links",
  columns: [
    "principal_id TEXT NOT NULL",
    "canonical_id TEXT NOT NULL",
    "evidence TEXT NOT NULL",
    "linked_by TEXT NOT NULL",
    "created_at BIGINT NOT NULL",
  ],
  primaryKey: ["principal_id"],
  backfill: {
    principal_id: "id",
    canonical_id: "json->>'canonicalId'",
    evidence: "json->>'evidence'",
    linked_by: "json->>'linkedBy'",
    created_at: "(json->>'createdAt')::bigint",
  },
  where: `json->>'canonicalId' IS NOT NULL AND json->>'evidence' IS NOT NULL
    AND json->>'linkedBy' IS NOT NULL AND json->>'createdAt' IS NOT NULL`,
});

const LINK_COLUMNS = "principal_id, canonical_id, evidence, linked_by, created_at";

function principalLink(row: Record<string, unknown>): PrincipalLink {
  return {
    principalId: String(row.principal_id),
    canonicalId: String(row.canonical_id),
    evidence: String(row.evidence),
    linkedBy: String(row.linked_by),
    createdAt: Number(row.created_at),
  };
}

export function createPrincipalLinkStore(): PrincipalLinkStore {
  const tenants = new Map<string, Map<string, PrincipalLink>>();
  const rows = () => {
    const tenant = currentTenant();
    return tenants.get(tenant) ?? tenants.set(tenant, new Map()).get(tenant)!;
  };
  return {
    list: async () => [...rows().values()],
    async insertIfAbsent(link) {
      const existing = rows().get(foldPrincipalId(link.principalId));
      if (existing) return existing;
      rows().set(foldPrincipalId(link.principalId), link);
      return link;
    },
    async take(principalId) {
      const link = rows().get(foldPrincipalId(principalId)) ?? null;
      rows().delete(foldPrincipalId(principalId));
      return link;
    },
  };
}

export function createPostgresPrincipalLinkStore(connectionString: string): PrincipalLinkStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, PRINCIPAL_LINKS_MIGRATION]);
  return {
    async list() {
      const rows = await q(
        `SELECT ${LINK_COLUMNS} FROM principal_links WHERE tenant_id = ${TENANT} ORDER BY created_at, principal_id`,
      );
      return rows.map(principalLink);
    },
    async insertIfAbsent(link) {
      const principalId = foldPrincipalId(link.principalId);
      const inserted = await q(
        `INSERT INTO principal_links(${LINK_COLUMNS}) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, principal_id) DO NOTHING RETURNING ${LINK_COLUMNS}`,
        [principalId, link.canonicalId, link.evidence, link.linkedBy, link.createdAt],
      );
      const [row] = inserted.length
        ? inserted
        : await q(`SELECT ${LINK_COLUMNS} FROM principal_links WHERE tenant_id = ${TENANT} AND principal_id = $1`, [
            principalId,
          ]);
      return row ? principalLink(row) : link;
    },
    async take(principalId) {
      const [row] = await q(
        `DELETE FROM principal_links WHERE tenant_id = ${TENANT} AND principal_id = $1 RETURNING ${LINK_COLUMNS}`,
        [foldPrincipalId(principalId)],
      );
      return row ? principalLink(row) : null;
    },
    close,
  };
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

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_ID_LENGTH;
}

export function createPrincipalLinkService(
  store: PrincipalLinkStore = createPrincipalLinkStore(),
  lock: AdvisoryLock = createMemoryAdvisoryLock(),
): PrincipalLinkService {
  const byAlias = new Map<string, PrincipalLink>();
  const byCanonical = new Map<string, PrincipalLink[]>();
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;

  function index(rows: PrincipalLink[]): void {
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
    if (refreshP && !force) return refreshP;
    while (refreshP) await refreshP;
    if (!force && Date.now() - refreshedAt < REFRESH_TTL_MS) return Promise.resolve();
    refreshP = store
      .list()
      .then(index)
      .then(() => {
        refreshedAt = Date.now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  return {
    canonical(key) {
      return byAlias.get(key)?.canonicalId;
    },
    aliases(key) {
      return (byCanonical.get(key) ?? []).map((row) => row.principalId);
    },
    refresh,
    async list() {
      await refresh(true);
      return [...byAlias.values()].sort(
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
        const stored = await store.insertIfAbsent({
          principalId,
          canonicalId,
          evidence,
          linkedBy: input.linkedBy,
          createdAt: Date.now(),
        });
        await refresh(true);
        if (foldPrincipalId(stored.canonicalId) !== canonicalKey)
          throw new PrincipalLinkError(409, `${principalId} is already linked to ${stored.canonicalId}`);
        return stored;
      });
    },
    async unlink(principalId) {
      return lock.withLock("principal-links", async () => {
        const row = await store.take(principalId);
        await refresh(true);
        return row;
      });
    },
  };
}
