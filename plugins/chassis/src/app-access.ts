import { parseScopeId } from "./scope-id.ts";

export type GeneralAccess = "restricted" | "org" | "public";

export const isOrgScope = (scope: string): boolean => parseScopeId(scope).kind === "org";

export function generalAccessOf(opts: { public: boolean; grantees: ReadonlyArray<{ scope: string }> }): GeneralAccess {
  if (opts.public) return "public";
  return opts.grantees.some((g) => isOrgScope(g.scope)) ? "org" : "restricted";
}

export const PUBLIC_ACCESS_NOTE = "Anyone on the internet with the link can open";

const YOUR_ORG = "your organization";

const named = (name?: string | null): string | undefined => name?.trim() || undefined;

export const orgAccessNote = (orgName?: string | null): string =>
  `Anyone signed in to ${named(orgName) ?? YOUR_ORG} can open`;

export const orgDisplayName = (name?: string | null): string =>
  named(name) ?? YOUR_ORG.charAt(0).toUpperCase() + YOUR_ORG.slice(1);
