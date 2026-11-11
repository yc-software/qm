export const isOrgScope = (scope: string): boolean => scope === "org" || scope.startsWith("org:");

export const PUBLIC_ACCESS_NOTE = "Anyone on the internet with the link can open";

export const orgAccessNote = (orgName: string): string => `Anyone signed in to ${orgName} can open`;
