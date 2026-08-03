import { resolveDirectoryMember, type DirectoryMember, type DirectoryStore } from "./directory-store.ts";
import { personKey, personKeys } from "./person.ts";

export function parseServicePrincipals(value: string | undefined): DirectoryMember[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("DIRECTORY_SERVICE_PRINCIPALS must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("DIRECTORY_SERVICE_PRINCIPALS must be a JSON array");
  const members: DirectoryMember[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("DIRECTORY_SERVICE_PRINCIPALS entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    const principalId = typeof record.principalId === "string" ? record.principalId.trim() : "";
    const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
    const slackId = typeof record.slackId === "string" ? record.slackId.trim() : "";
    const keys = Object.keys(record);
    if (keys.some((key) => key !== "principalId" && key !== "displayName" && key !== "slackId")) {
      throw new Error("DIRECTORY_SERVICE_PRINCIPALS entries contain an unknown field");
    }
    if (record.slackId !== undefined && (typeof record.slackId !== "string" || !slackId)) {
      throw new Error("DIRECTORY_SERVICE_PRINCIPALS slackId must be a non-empty string when present");
    }
    if (!principalId || !displayName) {
      throw new Error("DIRECTORY_SERVICE_PRINCIPALS entries require principalId and displayName");
    }
    const identityKeys = [personKey(principalId), personKey(slackId)].filter(Boolean);
    if (identityKeys.some((key) => seen.has(key))) {
      throw new Error(`DIRECTORY_SERVICE_PRINCIPALS contains an identity collision for ${principalId}`);
    }
    for (const key of identityKeys) seen.add(key);
    members.push({ principalId, displayName, type: "internal", ...(slackId ? { slackId } : {}) });
  }
  return members;
}

export function mergeServicePrincipals(
  members: readonly DirectoryMember[],
  servicePrincipals: readonly DirectoryMember[],
): DirectoryMember[] {
  return [...withoutServicePrincipals(members, servicePrincipals), ...servicePrincipals];
}

function withoutServicePrincipals(
  members: readonly DirectoryMember[],
  servicePrincipals: readonly DirectoryMember[],
): DirectoryMember[] {
  const serviceKeys = new Set(servicePrincipals.flatMap((member) => [...personKeys(member, member.principalId)]));
  return members.filter((member) => ![...personKeys(member, member.principalId)].some((key) => serviceKeys.has(key)));
}

export function withServicePrincipals(
  directory: DirectoryStore,
  servicePrincipals: readonly DirectoryMember[],
): DirectoryStore {
  const list = async (): Promise<DirectoryMember[]> =>
    mergeServicePrincipals(await directory.list(), servicePrincipals);
  return {
    ...directory,
    async replace(members) {
      await directory.replace(withoutServicePrincipals(members, servicePrincipals));
    },
    list,
    async get(principalId) {
      const key = personKey(principalId);
      return (await list()).find((member) => personKeys(member, member.principalId).has(key)) ?? null;
    },
    async resolve(query) {
      return resolveDirectoryMember(await list(), query);
    },
  };
}
