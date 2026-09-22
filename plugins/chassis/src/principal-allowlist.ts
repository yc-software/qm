export function principalInAllowlist(principalId: string, configuredPrincipals: string | undefined): boolean {
  const principal = principalId.trim().toLowerCase();
  if (!principal) return false;
  return (configuredPrincipals ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry === "all" || entry === principal);
}
