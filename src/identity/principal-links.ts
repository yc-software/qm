import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { foldPrincipalId, type PrincipalLinkResolver } from "../directory/person.ts";

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

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_ID_LENGTH;
}

export function createPrincipalLinkService(backing?: DurableMap<PrincipalLink>): PrincipalLinkService {
  const store = backing ?? createMemoryMap<PrincipalLink>();
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

  function refresh(force = false): Promise<void> {
    if (refreshP) return refreshP;
    if (!force && Date.now() - refreshedAt < REFRESH_TTL_MS) return Promise.resolve();
    refreshP = store
      .all()
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
      const stored = await store.putIfAbsent(aliasKey, {
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
    },
    async unlink(principalId) {
      const row = await store.take(foldPrincipalId(principalId));
      await refresh(true);
      return row;
    },
  };
}
