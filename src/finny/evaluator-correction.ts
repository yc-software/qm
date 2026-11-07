import { createHash } from "node:crypto";
import { assertFinnyApprovedEvaluatorRef } from "./policy.ts";
import type { FinnyStore } from "./store.ts";
import type { FinnyEvaluatorRef } from "./types.ts";

function correctionKey(jobId: string, evaluator: FinnyEvaluatorRef): string {
  const digest = createHash("sha256").update(JSON.stringify(evaluator)).digest("base64url");
  return `finny-evaluator-correction:${jobId}:${digest}`;
}

export async function reconcileFinnyEvaluatorCorrections(input: {
  jobs: Pick<FinnyStore, "evaluatorCorrectionCandidates" | "recordEvaluatorCorrection">;
  approvedEvaluator: FinnyEvaluatorRef;
}): Promise<number> {
  assertFinnyApprovedEvaluatorRef(input.approvedEvaluator);
  const candidates = await input.jobs.evaluatorCorrectionCandidates(input.approvedEvaluator);
  let corrected = 0;
  for (const job of candidates) {
    const result = await input.jobs.recordEvaluatorCorrection({
      scopeId: job.scopeId,
      jobId: job.id,
      fromEvaluator: job.policy.evaluator,
      toEvaluator: input.approvedEvaluator,
      idempotencyKey: correctionKey(job.id, input.approvedEvaluator),
    });
    if (!result.deduped) corrected += 1;
  }
  return corrected;
}
