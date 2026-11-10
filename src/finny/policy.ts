import {
  FINNY_CHANGE_KINDS,
  FINNY_CHECK_IDS,
  type FinnyChangeKind,
  type FinnyCheckId,
  type FinnyDeterministicEvidenceAuthority,
  type FinnyEvaluatorRef,
  type FinnyPolicySnapshot,
  type FinnyVerdict,
} from "./types.ts";

export { FINNY_CHANGE_KINDS, FINNY_CHECK_IDS } from "./types.ts";

export const FINNY_POLICY_VERSION = "finny-r5.1";

export const FINNY_DETERMINISTIC_CHECK_IDS = [
  "formula.recalculate",
  "summary.crossfoot",
  "artifact.structure",
] as const satisfies readonly FinnyCheckId[];

export function assertFinnyEvaluatorRef(evaluator: FinnyEvaluatorRef): void {
  if (!evaluator || typeof evaluator !== "object") throw new Error("Finny evaluator authority is invalid");
  for (const value of [
    evaluator.id,
    evaluator.revision,
    evaluator.buildDigest,
    evaluator.contractVersion,
    evaluator.configurationDigest,
  ]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Finny evaluator authority is invalid");
  }
}

const deterministicBlockCodes: Partial<Record<FinnyCheckId, string>> = {
  "formula.recalculate": "FORMULA_MISMATCH",
  "summary.crossfoot": "CROSSFOOT_MISMATCH",
  "artifact.structure": "STRUCTURE_INVALID",
};

export function assertFinnyApprovedEvaluatorRef(evaluator: FinnyEvaluatorRef): void {
  assertFinnyEvaluatorRef(evaluator);
  if (
    evaluator.contractVersion !== "finny.spreadsheet-worker.v2" ||
    !/^[a-f0-9]{64}$/.test(evaluator.buildDigest) ||
    !/^[a-f0-9]{64}$/.test(evaluator.configurationDigest)
  ) {
    throw new Error("Finny approved evaluator authority is invalid");
  }
}

export function assertFinnyDeterministicAuthority(
  authority: FinnyDeterministicEvidenceAuthority | undefined,
  checkId: FinnyCheckId,
  verdict: FinnyVerdict,
  evaluator: FinnyEvaluatorRef,
): void {
  const expectedBlockCode = deterministicBlockCodes[checkId];
  if (!expectedBlockCode) {
    if (authority !== undefined) throw new Error("Finny non-deterministic evidence cannot claim evaluator authority");
    return;
  }
  if (
    !authority ||
    authority.reasonSchemaVersion !== "finny.spreadsheet-worker.v2" ||
    !sameEvaluator(authority.evaluator, evaluator) ||
    authority.reasonCode !== (verdict === "pass" ? "PASS" : expectedBlockCode)
  ) {
    throw new Error("Finny deterministic evidence authority is invalid");
  }
}

function sameEvaluator(a: FinnyEvaluatorRef, b: FinnyEvaluatorRef): boolean {
  return (
    a.id === b.id &&
    a.revision === b.revision &&
    a.buildDigest === b.buildDigest &&
    a.contractVersion === b.contractVersion &&
    a.configurationDigest === b.configurationDigest
  );
}

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
  assertFinnyEvaluatorRef(policy.evaluator);
  if (policy.policyVersion !== FINNY_POLICY_VERSION) throw new Error("Finny policy version is invalid");
  const entries = Object.entries(policy.requiredGenerations);
  if (entries.length !== FINNY_CHECK_IDS.length) throw new Error("Finny policy check set is invalid");
  for (const [checkId, generation] of entries) {
    if (!checkIds.has(checkId) || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Finny policy generation is invalid");
    }
  }
}

export function initialFinnyPolicy(evaluator: FinnyEvaluatorRef): FinnyPolicySnapshot {
  assertFinnyApprovedEvaluatorRef(evaluator);
  return {
    policyVersion: FINNY_POLICY_VERSION,
    evaluator: { ...evaluator },
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
    evaluator: { ...current.evaluator },
    requiredGenerations: Object.fromEntries(
      FINNY_CHECK_IDS.map((checkId) => [
        checkId,
        current.requiredGenerations[checkId] + (invalidated.has(checkId) ? 1 : 0),
      ]),
    ) as Record<FinnyCheckId, number>,
  };
}

export function activateFinnyEvaluator(
  current: FinnyPolicySnapshot,
  evaluator: FinnyEvaluatorRef,
): FinnyPolicySnapshot {
  assertFinnyPolicy(current);
  assertFinnyApprovedEvaluatorRef(evaluator);
  const deterministic = new Set<FinnyCheckId>(FINNY_DETERMINISTIC_CHECK_IDS);
  return {
    policyVersion: FINNY_POLICY_VERSION,
    evaluator: { ...evaluator },
    requiredGenerations: Object.fromEntries(
      FINNY_CHECK_IDS.map((checkId) => [
        checkId,
        current.requiredGenerations[checkId] + (deterministic.has(checkId) ? 1 : 0),
      ]),
    ) as Record<FinnyCheckId, number>,
  };
}
