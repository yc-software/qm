export type DensityTier = "full" | "compact" | "card" | "strip";

const STRIP_MAX_H = 96;
const CARD_MAX_H = 300;
const CARD_MAX_W = 250;
const COMPACT_MAX_H = 540;
const COMPACT_MAX_W = 470;

export function densityTierFor(width: number, height: number): DensityTier {
  if (height <= STRIP_MAX_H) return "strip";
  if (height <= CARD_MAX_H || width <= CARD_MAX_W) return "card";
  if (height <= COMPACT_MAX_H || width <= COMPACT_MAX_W) return "compact";
  return "full";
}
