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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLACK_USER = /^(?:T[A-Z0-9]+:)?[UW][A-Z0-9]+$/;

/**
 * A principal and every handle linked to it. Third-party accounts (Composio users, Slack connections) were keyed
 * by whichever handle created them, so lookups try them all.
 */
export function personHandles(id: string): string[] {
  const principal = personKey(id);
  if (!principal) return [];
  return [...new Set([principal, ...(resolver?.handlesOf?.(principal) ?? [])])];
}

/** Comparison key for an id: the principal it names. Never stored; storage holds principal UUIDs from the edge. */
export function personKey(id: string | null | undefined): string {
  const key = normalizeHandle(id);
  if (!key || UUID.test(key)) return key.toLowerCase();
  return resolver?.principalOf(key) ?? key;
}

/** How people know a principal: an email, else a Slack user id, else the UUID itself. */
function readableHandle(id: string): string {
  if (!UUID.test(id)) return id;
  const handles = resolver?.handlesOf?.(id.toLowerCase()) ?? [];
  return handles.find((h) => h.includes("@")) ?? handles.find((h) => SLACK_USER.test(h)) ?? id;
}

/** A principal as prompts name it: `Display Name (handle)`, or just the handle. */
export function personLabel(person: { id: string; displayName?: string }): string {
  const handle = readableHandle(person.id);
  return person.displayName ? `${person.displayName} (${handle})` : handle;
}

/** How Slack addresses a principal: its Slack user id, else an email Slack can look up. */
export function slackHandleOf(id: string): string {
  if (!UUID.test(id)) return id;
  const handles = resolver?.handlesOf?.(id.toLowerCase()) ?? [];
  const slack = handles.find((h) => SLACK_USER.test(h));
  return slack?.split(":").at(-1) ?? handles.find((h) => h.includes("@")) ?? id;
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
