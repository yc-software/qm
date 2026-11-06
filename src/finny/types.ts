export const FINNY_CHECK_IDS = [
  "source.completeness",
  "financial.reconcile",
  "formula.recalculate",
  "summary.crossfoot",
  "meaning.actionability",
  "artifact.integrity",
  "artifact.structure",
  "lineage.binding",
] as const;

export type FinnyCheckId = (typeof FINNY_CHECK_IDS)[number];

export const FINNY_CHANGE_KINDS = ["source_or_logic", "formula", "disclosure", "presentation", "lineage"] as const;

export type FinnyChangeKind = (typeof FINNY_CHANGE_KINDS)[number];

export interface FinnyPolicySnapshot {
  policyVersion: string;
  requiredGenerations: Record<FinnyCheckId, number>;
}
