import type { FinnySpreadsheetEngineConfig } from "./integration-config.ts";
import type {
  SpreadsheetCalculationEngine,
  SpreadsheetCalculationInput,
  SpreadsheetWorkerResult,
} from "./deterministic-spreadsheet-worker.ts";

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
    throw new Error("Spreadsheet engine response exceeds the configured byte limit");
  }
  if (!response.body) throw new Error("Spreadsheet engine response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Spreadsheet engine response exceeds the configured byte limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("Spreadsheet engine response JSON is invalid", { cause: error });
  }
}

function resultsFromResponse(value: unknown): readonly SpreadsheetWorkerResult[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Spreadsheet engine response is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.results)) {
    throw new Error("Spreadsheet engine response is invalid");
  }
  return record.results as SpreadsheetWorkerResult[];
}

export function createHttpSpreadsheetCalculationEngine(
  config: FinnySpreadsheetEngineConfig,
  fetcher: typeof fetch = fetch,
): SpreadsheetCalculationEngine {
  return Object.freeze({
    name: config.name,
    version: config.version,
    evaluator: config.evaluator,
    async evaluate(input: SpreadsheetCalculationInput): Promise<readonly SpreadsheetWorkerResult[]> {
      if (input.artifactBytes.length > config.maxArtifactBytes) {
        throw new Error("Spreadsheet engine artifact exceeds the configured byte limit");
      }
      const response = await fetcher(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          artifactBase64: Buffer.from(input.artifactBytes).toString("base64"),
          binding: input.binding,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Spreadsheet engine request failed with ${response.status} ${response.statusText}`);
      }
      return resultsFromResponse(await boundedJson(response, config.maxResponseBytes));
    },
  });
}
