import { perTenant } from "../tenants/cache.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createTtlRefresh } from "../util/async.ts";
import { foldPrincipalId, type PrincipalLinkResolver } from "../directory/person.ts";
import { isSystemActor } from "../types.ts";
import { reportFailureAs } from "../util/errors.ts";
import type { UserLink, UserLinkStore } from "./user-store.ts";

interface PrincipalLinkInput {
  principalId: unknown;
  canonicalId: unknown;
  evidence: unknown;
  linkedBy: string;
}

export const APP_IS_NOT_A_PERSON = "that principal is a Slack bot or app, not a person, so it cannot be linked to one";

export class PrincipalLinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PrincipalLinkService extends PrincipalLinkResolver {
  list(): Promise<UserLink[]>;
  link(input: PrincipalLinkInput): Promise<UserLink>;
  unlink(principalId: string): Promise<UserLink | null>;
  refresh(force?: boolean): Promise<void>;
}

const MAX_ID_LENGTH = 255;
const MAX_EVIDENCE_LENGTH = 500;
const REFRESH_TTL_MS = 10_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_ID_LENGTH;
}

export function createPrincipalLinkService(store: UserLinkStore, lock: AdvisoryLock): PrincipalLinkService {
  const links = perTenant(() => ({
    byAlias: new Map<string, UserLink>(),
    byCanonical: new Map<string, UserLink[]>(),
    userOf: new Map<string, string>(),
    primaryOf: new Map<string, string>(),
    claimed: new Set<string>(),
    refresh: createTtlRefresh(REFRESH_TTL_MS, async () => index(await store.links())),
  }));

  function index(rows: UserLink[]): void {
    const { byAlias, byCanonical, userOf, primaryOf } = links();
    byAlias.clear();
    byCanonical.clear();
    userOf.clear();
    primaryOf.clear();
    for (const row of rows) {
      userOf.set(foldPrincipalId(row.principalId), row.userId);
      if (row.principalId === row.canonicalId) {
        primaryOf.set(row.userId, row.canonicalId);
        continue;
      }
      byAlias.set(foldPrincipalId(row.principalId), row);
      const key = foldPrincipalId(row.canonicalId);
      const list = byCanonical.get(key) ?? [];
      list.push(row);
      byCanonical.set(key, list);
    }
  }

  const refresh = (force?: boolean): Promise<void> => links().refresh(force);

  return {
    canonical(key) {
      return links().byAlias.get(key)?.canonicalId ?? links().primaryOf.get(key);
    },
    userId(key) {
      const { userOf, primaryOf } = links();
      return userOf.get(key) ?? (primaryOf.has(key) ? key : undefined);
    },
    claim(key, userId) {
      const { userOf, primaryOf, claimed } = links();
      if (isSystemActor(key) || claimed.has(key)) return;
      claimed.add(key);
      userOf.set(key, userId);
      primaryOf.set(userId, key);
      void store
        .ensure(key)
        .catch(reportFailureAs(`principal links: could not record the user for ${key}`, undefined))
        .finally(() => claimed.delete(key));
    },
    aliases(key) {
      return (links().byCanonical.get(key) ?? []).map((row) => row.principalId);
    },
    refresh,
    async list() {
      await refresh(true);
      return [...links().byAlias.values()].sort(
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
        const principalId = input.principalId.trim();
        const canonicalId = input.canonicalId.trim();
        const aliasKey = foldPrincipalId(principalId);
        const canonicalKey = foldPrincipalId(canonicalId);
        if (isSystemActor(aliasKey) || isSystemActor(canonicalKey))
          throw new PrincipalLinkError(400, "a system actor is QM itself, not a person, so it cannot be linked to one");
        const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
        if (!evidence || evidence.length > MAX_EVIDENCE_LENGTH)
          throw new PrincipalLinkError(400, `evidence must say how the two identities were verified as one person`);
        if (aliasKey === canonicalKey) throw new PrincipalLinkError(400, "a principal cannot be linked to itself");
        await refresh(true);
        const existing = links().byAlias.get(aliasKey);
        if (existing) {
          if (foldPrincipalId(existing.canonicalId) === canonicalKey) return existing;
          throw new PrincipalLinkError(409, `${principalId} is already linked to ${existing.canonicalId}`);
        }
        const canonicalIsAlias = links().byAlias.get(canonicalKey);
        if (canonicalIsAlias)
          throw new PrincipalLinkError(
            400,
            `${canonicalId} is itself linked to ${canonicalIsAlias.canonicalId}; link to that principal instead`,
          );
        if (links().byCanonical.has(aliasKey))
          throw new PrincipalLinkError(
            400,
            `${principalId} is the canonical principal of other links; unlink those first`,
          );
        const stored = await store.link({
          principalId: aliasKey,
          canonicalId: canonicalKey,
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
        const row = await store.unlink(foldPrincipalId(principalId));
        await refresh(true);
        return row;
      });
    },
  };
}
