import { swallowAs } from "../util/errors.ts";
import { createPrincipalGraph, type IdentityProvider } from "../identity/principals.ts";

export interface PrincipalResolver {
  principalOf(handle: string): string | undefined;
  identitiesOf(principalId: string): readonly { provider: IdentityProvider; externalId: string }[];
}

let resolver: PrincipalResolver = createPrincipalGraph();

export function installPrincipalResolver(next: PrincipalResolver | null): void {
  resolver = next ?? createPrincipalGraph();
}

export function normalizeHandle(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
}

/**
 * A principal and every handle linked to it. Third-party accounts (Composio users, Slack connections) were keyed
 * by whichever handle created them, so lookups try them all.
 */
export function personHandles(id: string): string[] {
  const principal = personKey(id);
  if (!principal) return [];
  return [...new Set([principal, ...resolver.identitiesOf(principal).map((i) => i.externalId)])];
}

export function personKey(id: string | null | undefined): string {
  const key = normalizeHandle(id);
  return key ? (resolver.principalOf(key) ?? key) : "";
}

export const identityOf = (id: string, provider: IdentityProvider): string | undefined =>
  resolver.identitiesOf(personKey(id)).find((i) => i.provider === provider)?.externalId;

export function personLabel(person: { id: string; displayName?: string }): string {
  const handle = identityOf(person.id, "email") ?? identityOf(person.id, "slack") ?? person.id;
  return person.displayName ? `${person.displayName} (${handle})` : handle;
}

export function slackHandleOf(id: string): string {
  return identityOf(id, "slack")?.split(":").at(-1) ?? identityOf(id, "email") ?? id;
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
