export function personKey(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
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
  const [ma, mb] = await Promise.all([directory.get(a).catch(() => null), directory.get(b).catch(() => null)]);
  const bKeys = personKeys(mb, b);
  for (const key of personKeys(ma, a)) if (bKeys.has(key)) return true;
  return false;
}

export async function samePersonMatcher(
  directory: { get(principalId: string): Promise<RosterPerson | null> },
  actorId: string,
): Promise<(id: string) => Promise<boolean>> {
  const row = await directory.get(actorId).catch(() => null);
  const keys = personKeys(row, actorId);
  return async (id) => {
    if (keys.has(personKey(id))) return true;
    if (row) return false;
    return samePersonInDirectory(directory, id, actorId);
  };
}
