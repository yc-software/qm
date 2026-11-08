const CLIENT_SURFACES = ["browser", "desktop", "ios"] as const;
export type ClientSurface = (typeof CLIENT_SURFACES)[number];
export const CLIENT_SURFACE_HEADER = "x-qm-client";

export function isClientSurface(value: unknown): value is ClientSurface {
  return typeof value === "string" && (CLIENT_SURFACES as readonly string[]).includes(value);
}

export function clientSurfaceOf(headers: Record<string, string | string[] | undefined>): ClientSurface {
  const declared = headers[CLIENT_SURFACE_HEADER];
  if (isClientSurface(declared)) return declared;
  const ua = typeof headers["user-agent"] === "string" ? headers["user-agent"] : "";
  if (/\bCFNetwork\//.test(ua) && /\bDarwin\//.test(ua)) return "ios";
  return "browser";
}
