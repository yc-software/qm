import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { customModelPricingKnown } from "../model/custom-providers.ts";
import { DEFAULT_AGENT_INPUT_USD_PER_MTOK, resolveModel } from "../model/pi-models.ts";

export interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
  reason?: "limit" | "unknown_pricing";
}

interface BudgetOperationIdentity {
  operationId: string;
  principalId: string;
  model: string;
  now?: number;
}

interface BudgetReservationInput extends BudgetOperationIdentity {
  reservedUsd: number;
  priceBasis?: string;
}

interface BudgetReservationResult extends BudgetCheck {
  priceBasis: string;
}

interface BudgetCheckpointInput {
  operationId: string;
  principalId: string;
  model: string;
  knownUsd: number;
  now?: number;
}

interface BudgetSettlementInput {
  operationId: string;
  principalId: string;
  model: string;
  settledUsd: number;
  now?: number;
}

export interface BudgetTracker {
  readonly enabled: boolean;
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
  lookupReservation(input: BudgetOperationIdentity): Promise<BudgetReservationResult | undefined>;
  reserve(input: BudgetReservationInput): Promise<BudgetReservationResult>;
  checkpoint(input: BudgetCheckpointInput): Promise<void>;
  settle(input: BudgetSettlementInput): Promise<void>;
}

export interface MeteredModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

export type ModelUsagePrice =
  | { priced: true; costUsd: number; basis: "reported_api_equivalent" | "api_equivalent" }
  | {
      priced: false;
      reason: string;
    };

export interface ModelUsageMeter {
  reserve(model: string, estimatedInputTokens: number): Promise<string>;
  checkpoint(
    operationId: string,
    model: string,
    usage: MeteredModelUsage,
    reportedApiEquivalentCostUsd?: number,
  ): Promise<void>;
  settle(
    operationId: string,
    model: string,
    usage: MeteredModelUsage,
    reportedApiEquivalentCostUsd?: number,
  ): Promise<void>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validUsage(usage: MeteredModelUsage): boolean {
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cacheWrite1h ?? 0].every(
    finiteNonnegative,
  );
}

interface ModelRateSet {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  inputTokensAbove?: number;
}

interface ModelPriceBasis {
  kind: "api_equivalent";
  requestedModel: string;
  catalogModel: string;
  rates: ModelRateSet;
  tiers: ModelRateSet[];
}

function priceableModel(modelId: string): Model<Api> | undefined {
  const model = resolveModel(modelId);
  if (!model || !customModelPricingKnown(modelId)) return undefined;
  const tiers = model.cost.tiers ?? [];
  const values = [
    model.cost.input,
    model.cost.output,
    model.cost.cacheRead,
    model.cost.cacheWrite,
    ...tiers.flatMap((tier) => [tier.inputTokensAbove, tier.input, tier.output, tier.cacheRead, tier.cacheWrite]),
  ];
  return values.every(finiteNonnegative) ? model : undefined;
}

function modelPriceBasis(modelId: string): ModelPriceBasis | undefined {
  if (modelId === "mock" || modelId === "mock-security") {
    const rates = {
      input: DEFAULT_AGENT_INPUT_USD_PER_MTOK,
      output: DEFAULT_AGENT_INPUT_USD_PER_MTOK,
      cacheRead: DEFAULT_AGENT_INPUT_USD_PER_MTOK,
      cacheWrite: DEFAULT_AGENT_INPUT_USD_PER_MTOK,
    };
    return { kind: "api_equivalent", requestedModel: modelId, catalogModel: modelId, rates, tiers: [] };
  }
  const model = priceableModel(modelId);
  if (!model) return undefined;
  return {
    kind: "api_equivalent",
    requestedModel: modelId,
    catalogModel: model.id,
    rates: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    tiers: (model.cost.tiers ?? []).map((tier) => ({
      inputTokensAbove: tier.inputTokensAbove,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite: tier.cacheWrite,
    })),
  };
}

function parseModelPriceBasis(value: string): ModelPriceBasis | undefined {
  try {
    const parsed = JSON.parse(value) as ModelPriceBasis;
    const sets = [parsed.rates, ...parsed.tiers];
    if (
      parsed.kind !== "api_equivalent" ||
      typeof parsed.requestedModel !== "string" ||
      typeof parsed.catalogModel !== "string" ||
      !Array.isArray(parsed.tiers) ||
      sets.some(
        (rates) =>
          !rates ||
          ![rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every(finiteNonnegative) ||
          (rates.inputTokensAbove !== undefined && !finiteNonnegative(rates.inputTokensAbove)),
      )
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function priceWithBasis(basis: ModelPriceBasis, usage: MeteredModelUsage): ModelUsagePrice {
  if (!validUsage(usage)) return { priced: false, reason: "usage is not finite and nonnegative" };
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates = basis.rates;
  let matchedThreshold = -1;
  for (const tier of basis.tiers) {
    const threshold = tier.inputTokensAbove ?? -1;
    if (inputTokens > threshold && threshold > matchedThreshold) {
      rates = tier;
      matchedThreshold = threshold;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  if (shortWrite < 0) return { priced: false, reason: "1h cache write exceeds total cache write usage" };
  const costUsd =
    (rates.input * usage.input +
      rates.output * usage.output +
      rates.cacheRead * usage.cacheRead +
      rates.cacheWrite * shortWrite +
      rates.input * 2 * longWrite) /
    1_000_000;
  return finiteNonnegative(costUsd)
    ? { priced: true, costUsd, basis: "api_equivalent" }
    : { priced: false, reason: `pricing produced an invalid cost for model ${basis.requestedModel}` };
}

export function priceModelUsage(
  modelId: string,
  usage: MeteredModelUsage,
  reportedApiEquivalentCostUsd?: number,
): ModelUsagePrice {
  if (!validUsage(usage)) return { priced: false, reason: "usage is not finite and nonnegative" };
  if (reportedApiEquivalentCostUsd !== undefined) {
    return finiteNonnegative(reportedApiEquivalentCostUsd)
      ? { priced: true, costUsd: reportedApiEquivalentCostUsd, basis: "reported_api_equivalent" }
      : { priced: false, reason: "reported API-equivalent cost is not finite and nonnegative" };
  }
  const basis = modelPriceBasis(modelId);
  if (!basis) return { priced: false, reason: `pricing is unavailable for model ${modelId}` };
  return priceWithBasis(basis, usage);
}

export function createModelUsageMeter(
  tracker: BudgetTracker | undefined,
  principalId: string,
  attemptId: string,
): ModelUsageMeter | undefined {
  if (!tracker?.enabled) return undefined;
  let ordinal = 0;
  const bases = new Map<string, ModelPriceBasis>();
  const price = (
    operationId: string,
    model: string,
    usage: MeteredModelUsage,
    reportedApiEquivalentCostUsd?: number,
  ) => {
    if (reportedApiEquivalentCostUsd !== undefined) return priceModelUsage(model, usage, reportedApiEquivalentCostUsd);
    const basis = bases.get(operationId);
    return basis
      ? priceWithBasis(basis, usage)
      : ({ priced: false, reason: `pricing basis is unavailable for budget operation ${operationId}` } as const);
  };
  return {
    async reserve(model, estimatedInputTokens) {
      const operationId = `${attemptId}:${ordinal++}`;
      const existing = await tracker.lookupReservation({ operationId, principalId, model });
      if (existing) {
        const storedBasis = parseModelPriceBasis(existing.priceBasis);
        if (!storedBasis) throw new Error(`budget reservation has an invalid pricing basis: ${operationId}`);
        bases.set(operationId, storedBasis);
        return operationId;
      }
      const basis = modelPriceBasis(model);
      if (!basis) throw new Error(`budget refused unpriced model request: pricing is unavailable for model ${model}`);
      const initial = priceWithBasis(basis, {
        input: Math.max(0, estimatedInputTokens),
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      if (!initial.priced) throw new Error(`budget refused unpriced model request: ${initial.reason}`);
      const result = await tracker.reserve({
        operationId,
        principalId,
        model,
        reservedUsd: initial.costUsd,
        priceBasis: JSON.stringify(basis),
      });
      if (!result.allowed)
        throw new Error(`budget exceeded ($${result.spentUsd.toFixed(2)} of $${result.limitUsd}); try again later`);
      const storedBasis = parseModelPriceBasis(result.priceBasis);
      if (!storedBasis) throw new Error(`budget reservation has an invalid pricing basis: ${operationId}`);
      bases.set(operationId, storedBasis);
      return operationId;
    },
    async checkpoint(operationId, model, usage, reportedApiEquivalentCostUsd) {
      const priced = price(operationId, model, usage, reportedApiEquivalentCostUsd);
      if (!priced.priced) throw new Error(`budget could not checkpoint model request: ${priced.reason}`);
      await tracker.checkpoint({ operationId, principalId, model, knownUsd: priced.costUsd });
    },
    async settle(operationId, model, usage, reportedApiEquivalentCostUsd) {
      const priced = price(operationId, model, usage, reportedApiEquivalentCostUsd);
      if (!priced.priced) throw new Error(`budget could not settle model request: ${priced.reason}`);
      await tracker.settle({ operationId, principalId, model, settledUsd: priced.costUsd });
    },
  };
}

interface MemoryOperation {
  principalId: string;
  model: string;
  reservedAt: number;
  reservedUsd: number;
  knownUsd: number;
  priceBasis: string;
  settledUsd?: number;
}

function assertAmount(value: number, name: string): void {
  if (!finiteNonnegative(value)) throw new Error(`${name} must be finite and nonnegative`);
}

export function createBudgetTracker(
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const spend = new Map<string, Array<{ at: number; usd: number }>>();
  const operations = new Map<string, MemoryOperation>();
  const orgKey = "@org";
  const enabled = Number.isFinite(limitUsd) || Number.isFinite(orgLimitUsd);

  function operationSpend(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    let total = 0;
    for (const op of operations.values()) {
      if (op.reservedAt >= cutoff && (principalId === orgKey || op.principalId === principalId))
        total += op.settledUsd ?? Math.max(op.reservedUsd, op.knownUsd);
    }
    return total;
  }

  function legacySpend(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (spend.get(principalId) ?? []).filter((entry) => entry.at >= cutoff);
    spend.set(principalId, kept);
    return kept.reduce((sum, entry) => sum + entry.usd, 0);
  }

  function spentIn(principalId: string, now: number): number {
    return legacySpend(principalId, now) + operationSpend(principalId, now);
  }

  function checkAt(principalId: string, now: number, additionalUsd = 0): BudgetCheck {
    const spentUsd = spentIn(principalId, now);
    if (spentUsd + additionalUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd, reason: "limit" };
    const orgSpent = spentIn(orgKey, now);
    return orgSpent + additionalUsd >= orgLimitUsd
      ? { allowed: false, spentUsd: orgSpent, limitUsd: orgLimitUsd, reason: "limit" }
      : { allowed: true, spentUsd, limitUsd };
  }

  return {
    enabled,
    async check(principalId, now = Date.now()) {
      return checkAt(principalId, now);
    },
    async record(principalId, costUsd, now = Date.now()) {
      assertAmount(costUsd, "costUsd");
      for (const key of [principalId, orgKey]) {
        const list = spend.get(key) ?? [];
        list.push({ at: now, usd: costUsd });
        spend.set(key, list);
      }
    },
    async lookupReservation(input) {
      const existing = operations.get(input.operationId);
      if (!existing) return undefined;
      if (existing.principalId !== input.principalId || existing.model !== input.model)
        throw new Error(`budget operation identity conflict: ${input.operationId}`);
      return {
        allowed: true,
        spentUsd: spentIn(input.principalId, input.now ?? Date.now()),
        limitUsd,
        priceBasis: existing.priceBasis,
      };
    },
    async reserve(input) {
      assertAmount(input.reservedUsd, "reservedUsd");
      const existing = operations.get(input.operationId);
      if (existing) {
        if (existing.principalId !== input.principalId || existing.model !== input.model)
          throw new Error(`budget operation identity conflict: ${input.operationId}`);
        return {
          allowed: true,
          spentUsd: spentIn(input.principalId, input.now ?? Date.now()),
          limitUsd,
          priceBasis: existing.priceBasis,
        };
      }
      const now = input.now ?? Date.now();
      const admitted = checkAt(input.principalId, now);
      if (!admitted.allowed) return { ...admitted, priceBasis: input.priceBasis ?? "" };
      const priceBasis = input.priceBasis ?? "";
      operations.set(input.operationId, {
        principalId: input.principalId,
        model: input.model,
        reservedAt: now,
        reservedUsd: input.reservedUsd,
        knownUsd: 0,
        priceBasis,
      });
      return {
        allowed: true,
        spentUsd: admitted.spentUsd + input.reservedUsd,
        limitUsd: admitted.limitUsd,
        priceBasis,
      };
    },
    async checkpoint(input) {
      assertAmount(input.knownUsd, "knownUsd");
      const existing = operations.get(input.operationId);
      if (!existing) throw new Error(`budget reservation not found: ${input.operationId}`);
      if (existing.principalId !== input.principalId || existing.model !== input.model)
        throw new Error(`budget operation identity conflict: ${input.operationId}`);
      if (existing.settledUsd === undefined) existing.knownUsd = Math.max(existing.knownUsd, input.knownUsd);
    },
    async settle(input) {
      assertAmount(input.settledUsd, "settledUsd");
      const existing = operations.get(input.operationId);
      if (!existing) throw new Error(`budget reservation not found: ${input.operationId}`);
      if (existing.principalId !== input.principalId || existing.model !== input.model)
        throw new Error(`budget operation identity conflict: ${input.operationId}`);
      if (existing.settledUsd !== undefined && existing.settledUsd !== input.settledUsd)
        throw new Error(`budget operation settlement conflict: ${input.operationId}`);
      existing.settledUsd = input.settledUsd;
    },
  };
}

export function budgetInvocationId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
