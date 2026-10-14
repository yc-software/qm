import { createHash } from "node:crypto";
import type { EmbeddingModel } from "./model-overlay.ts";
import { modelGatewayRequest, type ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import { providerTurnError } from "../harness/provider-error.ts";
import { httpFailure } from "../util/errors.ts";

export interface MemoryEmbedder {
  id: string;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export function unitVector(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16384 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error("Invalid memory embedding");
  }
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Invalid memory embedding norm");
  return value.map((v) => v / norm);
}

export function createMemoryEmbedder(
  model: EmbeddingModel,
  apiKey: string | null,
  gateway?: ModelGatewayTransportConfig,
  fetchImpl: typeof fetch = fetch,
): MemoryEmbedder {
  const routed = modelGatewayRequest(model.provider === "qm:gateway" ? gateway : undefined, model);
  const key = routed?.apiKey ?? apiKey;
  if (!key) throw new Error("Configure an organization credential for the embedding model");
  const url = `${(routed?.model ?? model).baseUrl}/embeddings`;
  const target = routed?.target ?? model.id;
  return {
    id: createHash("sha256")
      .update(JSON.stringify([url, target]))
      .digest("hex"),
    async embed(texts, signal) {
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json", ...(routed?.headers ?? { authorization: `Bearer ${key}` }) },
        body: JSON.stringify({ model: target, input: texts, encoding_format: "float" }),
      });
      if (!response.ok) {
        const error = providerTurnError({
          providerError: { status: response.status },
          errorMessage: `Embedding request failed (HTTP ${response.status})`,
        });
        error.cause = new Error(await httpFailure(response));
        throw error;
      }
      const body = (await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) throw new Error("Embedding provider returned invalid JSON", { cause: error });
        throw error;
      })) as { data?: Array<{ index: number; embedding: unknown }> };
      if (!Array.isArray(body.data) || body.data.length !== texts.length)
        throw new Error("Invalid memory embedding response");
      const rows = [...body.data].sort((a, b) => a.index - b.index);
      if (rows.some((row, i) => row.index !== i)) throw new Error("Invalid memory embedding indexes");
      const vectors = rows.map((row) => unitVector(row.embedding));
      if (vectors.some((v) => v.length !== vectors[0]!.length))
        throw new Error("Inconsistent memory embedding dimensions");
      return vectors;
    },
  };
}
