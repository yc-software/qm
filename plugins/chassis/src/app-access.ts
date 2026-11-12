export type GeneralAccess = "restricted" | "org" | "public";

export const isOrgScope = (scope: string): boolean => scope.startsWith("org:");

export function generalAccessOf(opts: { public: boolean; grantees: ReadonlyArray<{ scope: string }> }): GeneralAccess {
  if (opts.public) return "public";
  return opts.grantees.some((g) => isOrgScope(g.scope)) ? "org" : "restricted";
}

type IconNode = [tag: string, attrs: Record<string, string>][];

export const GENERAL_ACCESS_ICONS: Record<GeneralAccess, IconNode> = {
  restricted: [
    ["rect", { width: "18", height: "11", x: "3", y: "11", rx: "2", ry: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ],
  org: [
    ["path", { d: "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" }],
    ["path", { d: "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" }],
    ["path", { d: "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" }],
    ["path", { d: "M10 6h4" }],
    ["path", { d: "M10 10h4" }],
    ["path", { d: "M10 14h4" }],
    ["path", { d: "M10 18h4" }],
  ],
  public: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }],
    ["path", { d: "M2 12h20" }],
  ],
};

export const PUBLIC_ACCESS_NOTE = "Anyone on the internet with the link can open";

const orgNameOrNull = (name?: string | null): string | null => name?.trim() || null;

export const orgAccessNote = (name?: string | null): string =>
  `Anyone signed in to ${orgNameOrNull(name) ?? "your organization"} can open`;

export const orgDisplayName = (name?: string | null): string => orgNameOrNull(name) ?? "Your organization";
