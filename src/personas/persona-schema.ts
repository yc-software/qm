import { isSharedScope, parseScopeId, type ScopeId } from "../types.ts";

export const PERSONA_ROLES = ["read", "write", "owner"] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

const roleRank = (role: PersonaRole | null | undefined): number => (role ? PERSONA_ROLES.indexOf(role) + 1 : 0);
export const atLeast = (role: PersonaRole | null | undefined, floor: PersonaRole): boolean =>
  roleRank(role) >= roleRank(floor);
export const activeHolder = (holder: ScopeId, isActive: (principalId: string) => boolean): boolean => {
  const { kind, ref } = parseScopeId(holder);
  return !isSharedScope(holder) && (kind !== "personal" || isActive(ref!));
};
