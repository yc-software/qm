import type { JWTPayload } from "jose";

export function jwtClaims(value: unknown): JWTPayload | undefined {
  if (typeof value !== "string") return undefined;
  const segments = value.split(".");
  if (segments.length !== 3 || !segments[1]) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as JWTPayload) : undefined;
  } catch {
    return undefined;
  }
}
