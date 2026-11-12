export type GeneralAccess = "restricted" | "org" | "public";

export const isOrgScope = (scope: string): boolean => scope === "org" || scope.startsWith("org:");

export function generalAccessOf(opts: { public: boolean; grantees: ReadonlyArray<{ scope: string }> }): GeneralAccess {
  if (opts.public) return "public";
  return opts.grantees.some((g) => isOrgScope(g.scope)) ? "org" : "restricted";
}

export const PUBLIC_ACCESS_NOTE = "Anyone on the internet with the link can open";

const orgNameOrNull = (name?: string | null): string | null => name?.trim() || null;

export const orgAccessNote = (name?: string | null): string =>
  `Anyone signed in to ${orgNameOrNull(name) ?? "your organization"} can open`;

export const orgDisplayName = (name?: string | null): string => orgNameOrNull(name) ?? "Your organization";
