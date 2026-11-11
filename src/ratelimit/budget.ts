import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../model/pi-models.ts";
import type { Tenant } from "../tenants/context.ts";
interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
}

export interface BudgetTracker {
  check(tenant: Tenant, principalId: string, now?: number): Promise<BudgetCheck>;
  record(tenant: Tenant, principalId: string, costUsd: number, now?: number): Promise<void>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}
