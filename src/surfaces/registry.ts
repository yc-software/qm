import type { Surface, SurfacePromptHints } from "./contract.ts";

export type SurfaceToolPrompt = Pick<Surface, "label"> &
  Pick<SurfacePromptHints, "mentionSyntax"> & { textOnly?: boolean };

export function surfaceToolPrompt(surface: Surface): SurfaceToolPrompt {
  return {
    label: surface.label,
    mentionSyntax: surface.promptHints.mentionSyntax,
    ...(surface.capabilities.textOnly ? { textOnly: true } : {}),
  };
}

export interface SurfaceRegistry {
  get(kind: string): Surface | undefined;
}

export function createSurfaceRegistry(deps: { surfaces: readonly Surface[] }): SurfaceRegistry {
  const byKind = new Map<string, Surface>();
  for (const surface of deps.surfaces) {
    if (byKind.has(surface.kind)) throw new Error(`surface kinds must be unique: ${surface.kind}`);
    byKind.set(surface.kind, surface);
  }
  return { get: (kind) => byKind.get(kind) };
}
