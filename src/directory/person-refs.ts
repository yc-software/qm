export interface PrincipalLinkResolver {
  canonical(key: string): string | undefined;
  aliases(key: string): readonly string[];
  scopeAlias(key: string): string | undefined;
}

let links: PrincipalLinkResolver | null = null;

export function installPrincipalLinks(resolver: PrincipalLinkResolver | null): void {
  links = resolver;
}

export function principalLinks(): PrincipalLinkResolver | null {
  return links;
}

export function foldPrincipalId(id: string | null | undefined): string {
  const s = (id ?? "").trim();
  return s.includes("@") ? s.toLowerCase() : s;
}

export function personScopeAlias(id: string): string {
  const key = foldPrincipalId(id);
  return links?.scopeAlias(key) ?? links?.canonical(key) ?? key;
}

export function scopeAliasPerson(alias: string): string {
  return links?.canonical(alias) ?? alias;
}
