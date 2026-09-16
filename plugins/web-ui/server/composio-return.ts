export function composioCallbackUrl(publicUrl: string, returnTo: unknown, state: unknown): string | null {
  if (typeof returnTo !== "string" || typeof state !== "string" || !/^[a-zA-Z0-9_-]{20,100}$/.test(state)) return null;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || /[\\\r\n]/.test(returnTo) || returnTo.length > 4096)
    return null;
  const base = new URL(publicUrl);
  const target = new URL(returnTo, base);
  const prefix = base.pathname.replace(/\/$/, "");
  if (
    target.origin !== base.origin ||
    !(
      target.pathname === `${prefix}/` ||
      new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s/[a-zA-Z0-9_-]+$`).test(target.pathname)
    )
  )
    return null;
  for (const key of ["status", "error", "connectedAccountId", "composioReturn"]) target.searchParams.delete(key);
  target.hash = "";
  target.searchParams.set("composioReturn", state);
  return target.href;
}
