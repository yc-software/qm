import { surfaceLabel } from "./surface-capabilities.ts";

export const HANDOFF_INSTRUCTION =
  "When work needs another person's own logins, files or memory, follow the `hand-off` skill.";

export function reactionDetectGuidance(surface: string): string {
  return (
    `Express the reaction as one ${surfaceLabel(surface)} emoji short-name written WITH colons (e.g. \`:pray:\`), the one ` +
    "THIS persona would naturally reach for — common picks: `:pray:` (thanks), `:+1:` (got it), " +
    "`:rocket:`/`:tada:` (a win), `:eyes:` (on it) — but choose whatever genuinely fits, not a fixed menu."
  );
}
