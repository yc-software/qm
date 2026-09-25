export interface SuccessCheckResult {
  command: string;
  passed: boolean;
  detail?: string;
}

export interface JudgeVerdict {
  met: boolean;
  reason: string;
}

type SuccessOutcome = "met" | "continue" | "park";

export interface SuccessVerdict {
  outcome: SuccessOutcome;
  reason: string;
  checks: SuccessCheckResult[];
  judged: boolean;
}

export interface EvaluateSuccessInput {
  condition: string;
  attempt: number;
  checks?: string[];
  maxAttempts?: number;
  runCheck(command: string): Promise<SuccessCheckResult>;
  judge(input: { condition: string; checks: SuccessCheckResult[] }): Promise<JudgeVerdict>;
}

function bounded(
  attempt: number,
  maxAttempts: number | undefined,
  reason: string,
): Pick<SuccessVerdict, "outcome" | "reason"> {
  if (maxAttempts !== undefined && attempt >= maxAttempts)
    return { outcome: "park", reason: `attempt cap (${maxAttempts}) reached: ${reason}` };
  return { outcome: "continue", reason };
}

export async function evaluateSuccess(input: EvaluateSuccessInput): Promise<SuccessVerdict> {
  const checks: SuccessCheckResult[] = [];
  for (const command of input.checks ?? []) {
    const result = await input.runCheck(command);
    checks.push(result);
    if (!result.passed) {
      return {
        ...bounded(
          input.attempt,
          input.maxAttempts,
          result.detail ? `check failed: ${command} — ${result.detail}` : `check failed: ${command}`,
        ),
        checks,
        judged: false,
      };
    }
  }

  const verdict = await input.judge({ condition: input.condition, checks });
  if (verdict.met) return { outcome: "met", reason: verdict.reason, checks, judged: true };
  return {
    ...bounded(input.attempt, input.maxAttempts, verdict.reason),
    checks,
    judged: true,
  };
}
