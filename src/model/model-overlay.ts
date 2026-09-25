import { z } from "zod";

const price = z.number().finite().nonnegative();
const tokens = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const rates = { input: price, output: price, cacheRead: price, cacheWrite: price };
const schema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
  name: z.string().trim().min(1).max(200),
  provider: z.enum(["openai", "anthropic"]),
  template: z.string().min(1).max(200),
  contextWindow: tokens,
  maxTokens: tokens,
  cost: z.strictObject({
    ...rates,
    tiers: z
      .array(z.strictObject({ inputTokensAbove: tokens, ...rates }))
      .max(20)
      .optional(),
  }),
  fastMode: z.boolean().default(false),
  base: z.boolean().default(true),
  webui: z.boolean().default(true),
  auxiliary: z.boolean().default(false),
});

export type ModelOverlay = z.infer<typeof schema>;

export function parseModelOverlay(value: unknown): ModelOverlay {
  const model = schema.parse(value);
  if (model.maxTokens >= model.contextWindow) throw new Error("maxTokens must be less than contextWindow");
  if (model.fastMode && model.provider !== "anthropic")
    throw new Error("fast mode is supported only for Anthropic models");
  let previous = 0;
  for (const tier of model.cost.tiers ?? []) {
    if (tier.inputTokensAbove <= previous || tier.inputTokensAbove >= model.contextWindow)
      throw new Error("tier thresholds must increase and be below contextWindow");
    previous = tier.inputTokensAbove;
  }
  return model;
}
