import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { modelSupportsFastMode, resolveBuiltinModel } from "./pi-models.ts";
import type { ModelOverlay } from "./model-overlay.ts";
import type { ModelCredentialStore } from "./model-credential-store.ts";
import { providerBaseUrl } from "./provider-endpoints.ts";

export const modelLookupInput = z.strictObject({
  provider: z.enum(["openai", "anthropic"]),
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
});
export type ModelLookupInput = z.infer<typeof modelLookupInput>;

export function builtinModelSpec({ provider, id }: ModelLookupInput): ModelOverlay | undefined {
  const model = resolveBuiltinModel(id);
  if (!model || model.provider !== provider) return undefined;
  return {
    id,
    provider,
    name: model.name,
    template: id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: structuredClone(model.cost),
    fastMode: modelSupportsFastMode(id),
    base: true,
    webui: true,
    auxiliary: false,
  };
}

async function providerJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error("Metadata too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}
const providerMetadata = z.object({
  id: z.string(),
  display_name: z.string().trim().min(1).max(200).optional(),
  max_input_tokens: z.number().int().positive().safe().optional(),
  max_tokens: z.number().int().positive().safe().optional(),
});

export async function lookupModel(
  input: ModelLookupInput,
  credentials?: ModelCredentialStore,
  fetcher: typeof fetch = fetch,
) {
  const builtin = builtinModelSpec(input);
  if (builtin)
    return {
      kind: "builtin" as const,
      spec: builtin,
      missing: [] as string[],
      source: "Bundled model catalog",
      catalogGeneratedAt: getBuiltinModelDataGeneratedAt(),
      message:
        "This model already exists. Verify access and add it to the web picker; no duplicate definition or default change is needed.",
    };
  if (resolveBuiltinModel(input.id)) throw new Error("This model ID belongs to a different provider.");
  const spec: Partial<ModelOverlay> = { ...input, cost: undefined };
  let source = "Manual entry";
  let message: string;
  try {
    const key = await credentials?.resolve(input.provider);
    if (key) {
      const base =
        providerBaseUrl(input.provider) ??
        (input.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
      const suffix = input.provider === "anthropic" ? "/v1/models/" : "/models/";
      const headers: Record<string, string> =
        input.provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${key}` };
      const response = await fetcher(base.replace(/\/$/, "") + suffix + encodeURIComponent(input.id), {
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (response.ok) {
        const metadata = providerMetadata.parse(await providerJson(response));
        if (metadata.id !== input.id) throw new Error("Model ID mismatch");
        source = `${input.provider === "anthropic" ? "Anthropic" : "OpenAI"} model API`;
        spec.name = metadata.display_name ?? input.id;
        if (input.provider === "anthropic") {
          spec.contextWindow = metadata.max_input_tokens;
          spec.maxTokens = metadata.max_tokens;
          if (spec.contextWindow && spec.maxTokens && spec.maxTokens >= spec.contextWindow) {
            spec.contextWindow = undefined;
            spec.maxTokens = undefined;
          }
        }
        message =
          "Exact provider record found. Pricing and protocol compatibility still need confirmation. Lookup does not verify generation access.";
      } else {
        await response.body?.cancel();
        message =
          "The provider could not return metadata for this ID. Check the ID and credential access, or enter documented values manually.";
      }
    } else
      message =
        "No exact catalog match or organization provider key. Configure the key first, or enter documented values manually.";
  } catch {
    message = "Provider metadata could not be loaded. Retry lookup or enter documented values manually.";
  }
  const missing = ["name", "template", "contextWindow", "maxTokens"].filter(
    (key) => spec[key as keyof ModelOverlay] === undefined,
  );
  missing.push("input", "output", "cacheRead", "cacheWrite");
  return { kind: "new" as const, spec, missing, source, message };
}
