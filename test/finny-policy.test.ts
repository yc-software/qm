import { TEST_FINNY_EVALUATOR } from "./support/finny-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINNY_CHANGE_KINDS,
  FINNY_CHECK_IDS,
  FINNY_POLICY_VERSION,
  initialFinnyPolicy,
  blockedCheckChangeKinds,
  FINNY_DETERMINISTIC_CHECK_IDS,
  activateFinnyEvaluator,
  reviseFinnyPolicy,
} from "../src/finny/policy.ts";
import type { FinnyChangeKind, FinnyPolicySnapshot } from "../src/finny/types.ts";

const invalidated: Record<FinnyChangeKind, readonly string[]> = {
  source_or_logic: FINNY_CHECK_IDS,
  formula: [
    "formula.recalculate",
    "summary.crossfoot",
    "meaning.actionability",
    "artifact.integrity",
    "lineage.binding",
  ],
  disclosure: ["meaning.actionability", "artifact.integrity", "lineage.binding"],
  presentation: ["artifact.integrity", "artifact.structure", "lineage.binding"],
  lineage: ["lineage.binding"],
};

function changedChecks(before: FinnyPolicySnapshot, after: FinnyPolicySnapshot): string[] {
  return FINNY_CHECK_IDS.filter(
    (checkId) => after.requiredGenerations[checkId] !== before.requiredGenerations[checkId],
  );
}

test("initial policy requires every check at generation one", () => {
  const policy = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
  assert.equal(policy.policyVersion, FINNY_POLICY_VERSION);
  assert.ok(policy.evaluator.id);
  assert.deepEqual(Object.keys(policy.requiredGenerations), [...FINNY_CHECK_IDS]);
  assert.deepEqual(
    Object.values(policy.requiredGenerations),
    FINNY_CHECK_IDS.map(() => 1),
  );
});

for (const changeKind of FINNY_CHANGE_KINDS) {
  test(`${changeKind} increments only its invalidated checks`, () => {
    const before = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
    const after = reviseFinnyPolicy(before, [changeKind]);
    assert.deepEqual(changedChecks(before, after), invalidated[changeKind]);
    for (const checkId of invalidated[changeKind]) {
      assert.equal(after.requiredGenerations[checkId as keyof typeof after.requiredGenerations], 2);
    }
  });
}

test("combined and duplicate change kinds increment each check once", () => {
  const before = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
  const after = reviseFinnyPolicy(before, ["presentation", "lineage", "presentation"]);
  assert.deepEqual(changedChecks(before, after), ["artifact.integrity", "artifact.structure", "lineage.binding"]);
  assert.equal(after.requiredGenerations["lineage.binding"], 2);
});

test("empty and unknown change sets fail closed", () => {
  const policy = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
  assert.throws(() => reviseFinnyPolicy(policy, []), /change kind/i);
  assert.throws(() => reviseFinnyPolicy(policy, ["unknown" as FinnyChangeKind]), /change kind/i);
});

test("malformed policy snapshots fail closed", () => {
  const base = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
  const cases: unknown[] = [
    { ...base, policyVersion: "finny-r4" },
    { ...base, requiredGenerations: { ...base.requiredGenerations, "lineage.binding": 0 } },
    { ...base, requiredGenerations: { ...base.requiredGenerations, "lineage.binding": -1 } },
    { ...base, requiredGenerations: { ...base.requiredGenerations, "lineage.binding": 1.5 } },
    {
      ...base,
      requiredGenerations: Object.fromEntries(
        Object.entries(base.requiredGenerations).filter(([checkId]) => checkId !== "lineage.binding"),
      ),
    },
    { ...base, requiredGenerations: { ...base.requiredGenerations, "unknown.check": 1 } },
  ];
  for (const candidate of cases) {
    assert.throws(() => reviseFinnyPolicy(candidate as FinnyPolicySnapshot, ["lineage"]), /policy/i);
  }
});

test("blocked check invalidation is selected by Core", () => {
  assert.deepEqual(blockedCheckChangeKinds("formula.recalculate"), ["formula"]);
  assert.deepEqual(blockedCheckChangeKinds("artifact.structure"), ["presentation"]);
  assert.deepEqual(blockedCheckChangeKinds("lineage.binding"), ["lineage"]);
  assert.deepEqual(blockedCheckChangeKinds("source.completeness"), ["source_or_logic"]);
});

test("evaluator activation advances only Core deterministic generations", () => {
  const before = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
  const evaluator = {
    ...before.evaluator,
    revision: "next",
    buildDigest: "2".repeat(64),
    configurationDigest: "3".repeat(64),
  };
  const after = activateFinnyEvaluator(before, evaluator);
  assert.deepEqual(after.evaluator, evaluator);
  assert.deepEqual(changedChecks(before, after), [...FINNY_DETERMINISTIC_CHECK_IDS]);
});

test("policy requires a complete evaluator authority", () => {
  const policy = initialFinnyPolicy(TEST_FINNY_EVALUATOR);
  assert.throws(
    () => reviseFinnyPolicy({ ...policy, evaluator: { ...policy.evaluator, revision: "" } }, ["lineage"]),
    /evaluator authority/i,
  );
});
