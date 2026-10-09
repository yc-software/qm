import { swallowAs } from "../util/errors.ts";

export interface PrincipalResolver {
  principalOf(handle: string): string | undefined;
  handlesOf?(principalId: string): readonly string[];
}

let resolver: PrincipalResolver | null = null;

export function installPrincipalResolver(next: PrincipalResolver | null): void {
  resolver = next;
}

export function normalizeHandle(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
}

/** The principal UUID behind a handle, or the handle itself when it has never acted. */
export function principalOf(id: string): string {
  const key = normalizeHandle(id);
  if (!key) return id;
  return resolver?.principalOf(key) ?? key;
}

/**
 * A principal and every handle linked to it. Third-party accounts (Composio users, Slack connections) were keyed
 * by whichever handle created them, so lookups try them all.
 */
export function personHandles(id: string): string[] {
  const principal = principalOf(id);
  if (!principal) return [];
  return [...new Set([principal, ...(resolver?.handlesOf?.(principal) ?? [])])];
}

export function personKey(id: string | null | undefined): string {
  const key = normalizeHandle(id);
  return key ? principalOf(key) : "";
}

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = personKey(a);
  return key !== "" && key === personKey(b);
}

export interface RosterPerson {
  principalId?: string;
  slackId?: string;
}

export function personKeys(member: RosterPerson | null | undefined, rawId: string): Set<string> {
  const keys = new Set<string>();
  for (const id of [rawId, member?.principalId, member?.slackId]) {
    const key = personKey(id);
    if (key) keys.add(key);
  }
  return keys;
}

export async function samePersonInDirectory(
  directory: { get(principalId: string): Promise<RosterPerson | null> },
  a: string,
  b: string,
): Promise<boolean> {
  if (samePerson(a, b)) return true;
  if (!personKey(a) || !personKey(b)) return false;
  const [ma, mb] = await Promise.all([
    directory.get(a).catch(swallowAs("samePerson: directory lookup", null)),
    directory.get(b).catch(swallowAs("samePerson: directory lookup", null)),
  ]);
  const bKeys = personKeys(mb, b);
  for (const key of personKeys(ma, a)) if (bKeys.has(key)) return true;
  return false;
}

export async function samePersonMatcher(
  directory: { get(principalId: string): Promise<RosterPerson | null> },
  actorId: string,
): Promise<(id: string) => Promise<boolean>> {
  const row = await directory.get(actorId).catch(swallowAs("directory lookup", null));
  const keys = personKeys(row, actorId);
  return async (id) => {
    if (keys.has(personKey(id))) return true;
    if (row) return false;
    return samePersonInDirectory(directory, id, actorId);
  };
}
