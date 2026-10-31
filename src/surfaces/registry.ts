import type { Surface } from "./contract.ts";

export interface SurfaceRegistry {
  get(kind: string): Surface | undefined;
  label(kind: string): string | undefined;
}

export function createSurfaceRegistry(deps: { surfaces: readonly Surface[] }): SurfaceRegistry {
  const byKind = new Map<string, Surface>();
  for (const surface of deps.surfaces) {
    if (byKind.has(surface.kind)) throw new Error(`surface kinds must be unique: ${surface.kind}`);
    byKind.set(surface.kind, surface);
  }
  return {
    get: (kind) => byKind.get(kind),
    label: (kind) => byKind.get(kind)?.label,
  };
}
