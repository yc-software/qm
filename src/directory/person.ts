import { createPrincipalGraph, type IdentityProvider } from "../identity/principals.ts";

export interface PrincipalResolver {
  identitiesOf(principalId: string): readonly { provider: IdentityProvider; externalId: string }[];
}

let resolver: PrincipalResolver = createPrincipalGraph();

export function installPrincipalResolver(next: PrincipalResolver | null): void {
  resolver = next ?? createPrincipalGraph();
}

export function personKey(id: string | null | undefined): string {
  return (id ?? "").trim();
}

export const identityOf = (id: string, provider: IdentityProvider): string | undefined =>
  resolver.identitiesOf(personKey(id)).find((i) => i.provider === provider)?.externalId;

export function personLabel(person: { id: string; displayName?: string }): string {
  const handle = identityOf(person.id, "email") ?? identityOf(person.id, "slack");
  if (person.displayName && handle) return `${person.displayName} (${handle})`;
  return person.displayName || handle || "A teammate";
}

export const slackUserOf = (id: string): string | undefined => identityOf(id, "slack")?.split(":").at(-1);

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = personKey(a);
  return key !== "" && key === personKey(b);
}
