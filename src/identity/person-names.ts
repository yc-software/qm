import type { DirectoryStore } from "../directory/directory-store.ts";
import type { Tenant } from "../tenants/context.ts";
import { samePerson } from "../directory/person.ts";
import { swallowAs } from "../util/errors.ts";
import type { UserRecord, UserStore } from "./user-store.ts";

export const UNKNOWN_PERSON = "Unknown person";

const isOpaqueSignIn = (value: string): boolean => value.includes(":");

const isEmail = (value: string): boolean => /^[^\s@:]+@[^\s@]+$/.test(value.trim());

function realName(principalId: string, name: string | null | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || samePerson(trimmed, principalId) || /^oidc:/i.test(trimmed)) return undefined;
  return trimmed;
}

export function personLabel(
  principalId: string,
  known: { displayName?: string | null; user?: Pick<UserRecord, "displayName" | "aliases"> | null } = {},
): string {
  return (
    realName(principalId, known.displayName) ??
    realName(principalId, known.user?.displayName) ??
    (isEmail(principalId) ? principalId.trim() : undefined) ??
    known.user?.aliases.find(isEmail) ??
    (isOpaqueSignIn(principalId) ? UNKNOWN_PERSON : principalId.trim())
  );
}

export interface PersonNames {
  storedNames(principalIds: readonly string[]): Promise<Map<string, string>>;
  labels(principalIds: readonly string[]): Promise<Map<string, string>>;
}

export function createPersonNames(
  tenant: Tenant,
  deps: {
    users?: Pick<UserStore, "resolve">;
    directory?: Pick<DirectoryStore, "get">;
  },
): PersonNames {
  const resolve = async (ids: readonly string[]): Promise<Map<string, UserRecord>> =>
    ids.length && deps.users
      ? await deps.users
          .resolve(tenant, ids)
          .catch(swallowAs("person names: resolve users", new Map<string, UserRecord>()))
      : new Map();
  const directoryName = async (id: string): Promise<string | undefined> =>
    realName(
      id,
      (await deps.directory?.get(tenant, id).catch(swallowAs("person names: directory lookup", null)))?.displayName,
    );
  return {
    async storedNames(principalIds) {
      const found = await resolve(principalIds);
      const names = new Map<string, string>();
      for (const id of principalIds) {
        const name = realName(id, found.get(id)?.displayName);
        if (name) names.set(id, name);
      }
      return names;
    },
    async labels(principalIds) {
      const ids = [...new Set(principalIds)];
      const [found, listed] = await Promise.all([resolve(ids), Promise.all(ids.map(directoryName))]);
      return new Map(
        ids.map((id, i) => [id, personLabel(id, { displayName: listed[i], user: found.get(id) })] as const),
      );
    },
  };
}
