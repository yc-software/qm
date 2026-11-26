export function appEditSlug(threadRef: string | null | undefined, user: string | null | undefined): string | null {
  if (!threadRef || !user) return null;
  const prefix = `web:${user}:app-edit:`;
  if (!threadRef.startsWith(prefix)) return null;
  const slug = threadRef.slice(prefix.length);
  return /^[a-z0-9-]{1,63}$/.test(slug) ? slug : null;
}
