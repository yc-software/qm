import {
  FINNY_CHANGE_KINDS,
  FINNY_CHECK_IDS,
  type FinnyChangeKind,
  type FinnyCheckId,
  type FinnyPolicySnapshot,
} from "./types.ts";

export { FINNY_CHANGE_KINDS, FINNY_CHECK_IDS } from "./types.ts";

export const FINNY_POLICY_VERSION = "finny-r5.1";

const invalidatedChecks: Record<FinnyChangeKind, readonly FinnyCheckId[]> = {
  source_or_logic: FINNY_CHECK_IDS,
  formula: [
    "formula.recalculate",
    "summary.crossfoot",
    "meaning.actionability",
    "artifact.integrity",
    "lineage.binding",
  ],
  disclosure: ["meaning.actionability", "artifact.integrity", "lineage.binding"],
  presentation: ["artifact.structure", "artifact.integrity", "lineage.binding"],
  lineage: ["lineage.binding"],
};

const blockedCheckChangeKind: Record<FinnyCheckId, FinnyChangeKind> = {
  "source.completeness": "source_or_logic",
  "financial.reconcile": "source_or_logic",
  "formula.recalculate": "formula",
  "summary.crossfoot": "formula",
  "meaning.actionability": "disclosure",
  "artifact.integrity": "source_or_logic",
  "artifact.structure": "presentation",
  "lineage.binding": "lineage",
};

export function blockedCheckChangeKinds(checkId: FinnyCheckId): FinnyChangeKind[] {
  return [blockedCheckChangeKind[checkId]];
}

const checkIds = new Set<string>(FINNY_CHECK_IDS);
const changeKinds = new Set<string>(FINNY_CHANGE_KINDS);

export function assertFinnyPolicy(policy: FinnyPolicySnapshot): void {
  if (policy.policyVersion !== FINNY_POLICY_VERSION) throw new Error("Finny policy version is invalid");
  const entries = Object.entries(policy.requiredGenerations);
  if (entries.length !== FINNY_CHECK_IDS.length) throw new Error("Finny policy check set is invalid");
  for (const [checkId, generation] of entries) {
    if (!checkIds.has(checkId) || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Finny policy generation is invalid");
    }
  }
}

export function initialFinnyPolicy(): FinnyPolicySnapshot {
  return {
    policyVersion: FINNY_POLICY_VERSION,
    requiredGenerations: Object.fromEntries(FINNY_CHECK_IDS.map((checkId) => [checkId, 1])) as Record<
      FinnyCheckId,
      number
    >,
  };
}

export function reviseFinnyPolicy(
  current: FinnyPolicySnapshot,
  requestedChangeKinds: readonly FinnyChangeKind[],
): FinnyPolicySnapshot {
  assertFinnyPolicy(current);
  if (!requestedChangeKinds.length || requestedChangeKinds.some((changeKind) => !changeKinds.has(changeKind))) {
    throw new Error("Finny change kind is invalid");
  }
  const invalidated = new Set<FinnyCheckId>();
  for (const changeKind of requestedChangeKinds) {
    for (const checkId of invalidatedChecks[changeKind]) invalidated.add(checkId);
  }
  return {
    policyVersion: FINNY_POLICY_VERSION,
    requiredGenerations: Object.fromEntries(
      FINNY_CHECK_IDS.map((checkId) => [
        checkId,
        current.requiredGenerations[checkId] + (invalidated.has(checkId) ? 1 : 0),
      ]),
    ) as Record<FinnyCheckId, number>,
  };
}
