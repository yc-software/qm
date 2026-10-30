export function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
