export function personalScopeIdFor(user: string | null | undefined): string | null {
  return user ? `personal:${user}` : null;
}

export function effectiveScopeId(
  explicitScopeId: string | null | undefined,
  user: string | null | undefined,
): string | null {
  return explicitScopeId || personalScopeIdFor(user);
}
