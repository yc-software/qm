import { createHash } from "node:crypto";

export interface MemoryEmbeddingConfig {
  url: string;
  model: string;
  apiKey: string;
}

export interface MemoryEmbedder {
  id: string;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export function parseMemoryEmbeddingConfig(env: Record<string, string | undefined>): MemoryEmbeddingConfig | undefined {
  const url = env.MEMORY_EMBEDDING_URL?.trim();
  const model = env.MEMORY_EMBEDDING_MODEL?.trim();
  const apiKey = env.MEMORY_EMBEDDING_API_KEY?.trim();
  if (!url && !model && !apiKey) return undefined;
  if (!url || !model || !apiKey)
    throw new Error("MEMORY_EMBEDDING_URL, MEMORY_EMBEDDING_MODEL and MEMORY_EMBEDDING_API_KEY are required together");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MEMORY_EMBEDDING_URL must be a valid HTTP(S) endpoint");
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("MEMORY_EMBEDDING_URL must be an HTTP(S) endpoint without credentials or a fragment");
  }
  return { url, model, apiKey };
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

export function createMemoryEmbedder(config: MemoryEmbeddingConfig, fetchImpl: typeof fetch = fetch): MemoryEmbedder {
  return {
    id: createHash("sha256")
      .update(JSON.stringify([config.url, config.model]))
      .digest("hex"),
    async embed(texts, signal) {
      const response = await fetchImpl(config.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, input: texts, encoding_format: "float" }),
      });
      // Provider error bodies can contain submitted text or credentials; never log them.
      if (!response.ok) throw new Error(`Memory embedding request failed (${response.status})`);
      const body = (await response.json()) as { data?: Array<{ index: number; embedding: unknown }> };
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
