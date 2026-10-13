export const SHARING_POSTURES = ["isolated", "open"] as const;
export type SharingPosture = (typeof SHARING_POSTURES)[number];

export function parseSharingPosture(value: unknown): SharingPosture | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (SHARING_POSTURES as readonly string[]).includes(normalized) ? (normalized as SharingPosture) : null;
}

export function composeSharingPosture(ceiling: SharingPosture, narrower?: SharingPosture | null): SharingPosture {
  return ceiling === "isolated" || narrower === "isolated" ? "isolated" : "open";
}

export function composeSharingPostures(
  ceiling: SharingPosture,
  narrower: readonly (SharingPosture | null | undefined)[],
): SharingPosture {
  return narrower.reduce<SharingPosture>(composeSharingPosture, ceiling);
}
