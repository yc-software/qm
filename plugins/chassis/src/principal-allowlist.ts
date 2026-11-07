export function listedPrincipals(configured: string | undefined): string[] {
  return (configured ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function principalInAllowlist(principalId: string, configuredPrincipals: string | undefined): boolean {
  const principal = principalId.trim().toLowerCase();
  if (!principal) return false;
  return listedPrincipals(configuredPrincipals)
    .map((entry) => entry.toLowerCase())
    .some((entry) => entry === "all" || entry === principal);
}

export function principalListed(principalId: string, configuredPrincipals: string | undefined): boolean {
  const principal = principalId.trim().toLowerCase();
  return principal !== "" && listedPrincipals(configuredPrincipals).some((entry) => entry.toLowerCase() === principal);
}
