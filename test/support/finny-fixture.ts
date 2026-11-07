import type { FinnyEvaluatorRef } from "../../src/finny/types.ts";

export const TEST_FINNY_EVALUATOR: FinnyEvaluatorRef = Object.freeze({
  id: "test-finny-spreadsheet-evaluator",
  revision: "test-r1",
  buildDigest: "0".repeat(64),
  contractVersion: "finny.spreadsheet-worker.v2",
  configurationDigest: "1".repeat(64),
});
