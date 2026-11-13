import type { Surface, SurfaceCapabilities, SurfacePromptHints } from "./contract.ts";

export type SurfaceToolPrompt = Pick<Surface, "label"> &
  Pick<SurfacePromptHints, "mentionSyntax"> & { textOnly?: boolean };

export function turnCapabilities(
  surface: Surface | undefined,
  turn: { surface?: string; liveReplies?: boolean },
): SurfaceCapabilities | undefined {
  if (!surface || !turn.liveReplies || turn.surface !== surface.kind) return surface?.capabilities;
  return { ...surface.capabilities, liveReplies: true, textOnly: false };
}

export function surfaceToolPrompt(
  surface: Surface,
  turn: { surface?: string; liveReplies?: boolean } = {},
): SurfaceToolPrompt {
  return {
    label: surface.label,
    mentionSyntax: surface.promptHints.mentionSyntax,
    ...(turnCapabilities(surface, turn)?.textOnly ? { textOnly: true } : {}),
  };
}

export interface SurfaceRegistry {
  get(kind: string): Surface | undefined;
  list(): readonly Surface[];
}

export function createSurfaceRegistry(deps: { surfaces: readonly Surface[] }): SurfaceRegistry {
  const byKind = new Map<string, Surface>();
  for (const surface of deps.surfaces) {
    if (byKind.has(surface.kind)) throw new Error(`surface kinds must be unique: ${surface.kind}`);
    byKind.set(surface.kind, surface);
  }
  return { get: (kind) => byKind.get(kind), list: () => deps.surfaces };
}
