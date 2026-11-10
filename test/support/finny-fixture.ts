import type { FinnyEvaluatorRef } from "../../src/finny/types.ts";

export const TEST_FINNY_EVALUATOR: FinnyEvaluatorRef = Object.freeze({
  id: "test-finny-spreadsheet-evaluator",
  revision: "test-r1",
  buildDigest: "0".repeat(64),
  contractVersion: "finny.spreadsheet-worker.v2",
  configurationDigest: "1".repeat(64),
});

export function testDeterministicAuthority(
  checkId: string,
  verdict: "pass" | "block",
  evaluator = TEST_FINNY_EVALUATOR,
) {
  const blockCodes: Record<string, string> = {
    "formula.recalculate": "FORMULA_MISMATCH",
    "summary.crossfoot": "CROSSFOOT_MISMATCH",
    "artifact.structure": "STRUCTURE_INVALID",
  };
  const blockCode = blockCodes[checkId];
  return blockCode
    ? {
        deterministicAuthority: {
          evaluator,
          reasonSchemaVersion: "finny.spreadsheet-worker.v2" as const,
          reasonCode: verdict === "pass" ? "PASS" : blockCode,
        },
      }
    : {};
}
