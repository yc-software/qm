import { isPrincipalType, type Principal } from "../types.ts";

export const MAX_CAPABILITY_CLAIMS_BYTES = 1024 * 1024;

interface ParticipantSnapshot {
  records: Principal[];
  scope?: number[];
  keychain?: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPrincipal(value: unknown): value is Principal {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isPrincipalType(value.type) &&
    (value.displayName === undefined || typeof value.displayName === "string") &&
    (value.teamIds === undefined ||
      (Array.isArray(value.teamIds) && value.teamIds.every((id) => typeof id === "string")))
  );
}

export function packCapabilityParticipants(value: Record<string, unknown>): Record<string, unknown> {
  const { members, keychainMembers, ...claims } = value;
  if (members === undefined && keychainMembers === undefined) return value;
  const records: Principal[] = [];
  const positions = new Map<string, number>();
  const references = (members: unknown): number[] | undefined => {
    if (members === undefined) return undefined;
    if (!Array.isArray(members) || !members.every(isPrincipal)) throw new Error("Invalid capability participants");
    return members.map((member) => {
      const key = JSON.stringify(Object.fromEntries(Object.entries(member).sort(([a], [b]) => a.localeCompare(b))));
      const existing = positions.get(key);
      if (existing !== undefined) return existing;
      const index = records.length;
      records.push(member);
      positions.set(key, index);
      return index;
    });
  };
  const scope = references(members);
  const keychain = references(keychainMembers);
  const participants: ParticipantSnapshot = {
    records,
    ...(scope !== undefined ? { scope } : {}),
    ...(keychain !== undefined ? { keychain } : {}),
  };
  return { encoding: "participants-v1", claims, participants };
}

export function unpackCapabilityParticipants(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (!("encoding" in value)) return value;
  if (value.encoding !== "participants-v1" || !isRecord(value.claims) || !isRecord(value.participants)) return null;
  const { claims, participants } = value;
  if ("members" in claims || "keychainMembers" in claims || "encoding" in claims) return null;
  if (!Array.isArray(participants.records) || !participants.records.every(isPrincipal)) return null;
  const records = participants.records;
  const { scope, keychain } = participants;
  const validReferences = (refs: unknown): refs is number[] | undefined =>
    refs === undefined ||
    (Array.isArray(refs) && refs.every((index) => Number.isSafeInteger(index) && index >= 0 && index < records.length));
  if (!validReferences(scope) || !validReferences(keychain)) return null;
  const sizes = records.map((record) => Buffer.byteLength(JSON.stringify(record)));
  let bytes = Buffer.byteLength(
    JSON.stringify({
      ...claims,
      ...(scope !== undefined ? { members: [] } : {}),
      ...(keychain !== undefined ? { keychainMembers: [] } : {}),
    }),
  );
  for (const refs of [scope, keychain]) {
    if (!refs) continue;
    bytes += Math.max(0, refs.length - 1);
    for (const index of refs) {
      bytes += sizes[index]!;
      if (bytes > MAX_CAPABILITY_CLAIMS_BYTES) return null;
    }
  }
  if (bytes > MAX_CAPABILITY_CLAIMS_BYTES) return null;
  return {
    ...claims,
    ...(scope !== undefined ? { members: scope.map((index) => structuredClone(records[index]!)) } : {}),
    ...(keychain !== undefined ? { keychainMembers: keychain.map((index) => structuredClone(records[index]!)) } : {}),
  };
}
