import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../model/pi-models.ts";
interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}

/**
 * Cost attribution for one model call, preferring the provider-metered usage
 * the harnesses already report through recordLlmRequest (LlmCallUsage) and
 * falling back to the input-only fixed-rate estimate when no metered numbers
 * exist (#586).
 */
export function modelCallCostUsd(
  rec: { model: string; inputTokens: number },
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costUsd: number;
  } | null,
): number {
  if (usage) {
    if (Number.isFinite(usage.costUsd) && usage.costUsd > 0) return usage.costUsd;
    // Metered tokens without a provider-computed cost: price input+output at
    // the conservative fixed rate instead of dropping the output share.
    return estimateCostUsd(usage.input + usage.output);
  }
  return estimateCostUsd(rec.inputTokens);
}

export function createBudgetTracker(
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const spend = new Map<string, Array<{ at: number; usd: number }>>();
  const orgKey = "@org";

  function spentIn(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (spend.get(principalId) ?? []).filter((e) => e.at >= cutoff);
    spend.set(principalId, kept);
    return kept.reduce((s, e) => s + e.usd, 0);
  }

  return {
    async check(principalId, now = Date.now()) {
      const spentUsd = spentIn(principalId, now);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgSpent = spentIn(orgKey, now);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(principalId, costUsd, now = Date.now()) {
      for (const key of [principalId, orgKey]) {
        const list = spend.get(key) ?? [];
        list.push({ at: now, usd: costUsd });
        spend.set(key, list);
      }
    },
  };
}
