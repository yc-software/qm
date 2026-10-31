import { swallowAs } from "../util/errors.ts";

export interface PrincipalLinkResolver {
  canonical(key: string): string | undefined;
  aliases(key: string): readonly string[];
}

let links: PrincipalLinkResolver | null = null;

export function installPrincipalLinks(resolver: PrincipalLinkResolver | null): void {
  links = resolver;
}

export function foldPrincipalId(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
}

export function canonicalPerson(id: string): string {
  const key = foldPrincipalId(id);
  if (!key) return id;
  return links?.canonical(key) ?? id;
}

export class UnattestableActor extends Error {
  readonly code = "invalid_actor";
}

export const UNATTESTABLE_ACTOR_FIX =
  "Link this member to a principal id of 1 to 256 visible ASCII characters with POST /v1/admin/principal-links (docs/principal-links.md).";

export function attestableActor(id: unknown): string | undefined {
  return typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id) ? id : undefined;
}

export function attestedPerson(id: string | undefined, callee: string): string {
  const actor = attestableActor(id && canonicalPerson(id));
  if (!actor)
    throw new UnattestableActor(`${callee} needs a signed-in person QM can attest. ${UNATTESTABLE_ACTOR_FIX}`);
  return actor;
}

export function personIds(id: string): string[] {
  const key = foldPrincipalId(id);
  if (!key) return [];
  const canonical = links?.canonical(key) ?? id.trim();
  return [canonical, ...(links?.aliases(foldPrincipalId(canonical)) ?? [])];
}

export function rosterIds(id: string): string[] {
  const ids = [id.trim(), ...personIds(id)].filter(Boolean);
  return [...new Set(ids.flatMap((x) => [x, foldPrincipalId(x)]))];
}

export function personKey(id: string | null | undefined): string {
  const key = foldPrincipalId(id);
  if (!key) return "";
  return foldPrincipalId(links?.canonical(key) ?? key);
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

type RosterLookup = { get(principalId: string): Promise<RosterPerson | null> };

async function rosterRow(directory: RosterLookup, id: string, label: string): Promise<RosterPerson | null> {
  const canonical = canonicalPerson(id);
  const row = await directory.get(canonical).catch(swallowAs(label, null));
  return row ?? (canonical === id ? null : await directory.get(id).catch(swallowAs(label, null)));
}

export async function samePersonInDirectory(directory: RosterLookup, a: string, b: string): Promise<boolean> {
  if (samePerson(a, b)) return true;
  if (!personKey(a) || !personKey(b)) return false;
  const [ma, mb] = await Promise.all([
    rosterRow(directory, a, "samePerson: directory lookup"),
    rosterRow(directory, b, "samePerson: directory lookup"),
  ]);
  const bKeys = personKeys(mb, b);
  for (const key of personKeys(ma, a)) if (bKeys.has(key)) return true;
  return false;
}

export async function samePersonMatcher(
  directory: RosterLookup,
  actorId: string,
): Promise<(id: string) => Promise<boolean>> {
  const row = await rosterRow(directory, actorId, "directory lookup");
  const keys = personKeys(row, actorId);
  return async (id) => {
    if (keys.has(personKey(id))) return true;
    if (row) return false;
    return samePersonInDirectory(directory, id, actorId);
  };
}
