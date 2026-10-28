import { readCappedText } from "../util/response-body.ts";
import { randomUUID } from "node:crypto";
import { MAX_SCREEN_CHARS, type SecurityScreenVerdict } from "./security-screen.ts";
import { swallow } from "../util/errors.ts";
import { fetchWithRetry } from "../util/async.ts";

export type SecurityScreenHook = "user_input" | "tool_response";

export interface SecurityScreenClassification {
  verdict: SecurityScreenVerdict;
  score: number;
  threshold: number;
  outcome?: string;
}

export interface SecurityScreener {
  readonly provider: string;
  classify(input: {
    payload: string;
    hook: SecurityScreenHook;
    metadata?: Readonly<Record<string, unknown>>;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<SecurityScreenClassification>;
}

const MAX_SECURITY_SCREEN_RESPONSE_BYTES = 64 * 1024;
export const SECURITY_SCREEN_CHUNK_CHARS = 1_600;
const SECURITY_SCREEN_CHUNK_OVERLAP_CHARS = 256;
const SECURITY_SCREEN_RETRY_BASE_MS = 500;
const OUTCOME = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function securityScreenChunks(text: string): string[] {
  const normalized = text.toWellFormed();
  if (normalized.length <= SECURITY_SCREEN_CHUNK_CHARS) return [normalized];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + SECURITY_SCREEN_CHUNK_CHARS, normalized.length);
    const endCode = normalized.charCodeAt(end);
    if (end < normalized.length && endCode >= 0xdc00 && endCode <= 0xdfff) {
      end -= 1;
    }
    chunks.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    start = Math.max(end - SECURITY_SCREEN_CHUNK_OVERLAP_CHARS, start + 1);
    const startCode = normalized.charCodeAt(start);
    if (startCode >= 0xdc00 && startCode <= 0xdfff) start += 1;
  }
  return chunks;
}

async function classifyChunks<T>(
  chunks: string[],
  classify: (chunk: string, index: number, signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T[]> {
  const results: T[] = [];
  const abort = new AbortController();
  const batchSignal = AbortSignal.any([signal, abort.signal]);
  let failed = false;
  let failure: unknown;

  for (let start = 0; start < chunks.length; start += 2) {
    if (batchSignal.aborted) throw batchSignal.reason;
    const pending = chunks.slice(start, start + 2).map(async (chunk, offset) => {
      try {
        return await classify(chunk, start + offset, batchSignal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          abort.abort(error);
        }
        throw error;
      }
    });
    const settled = await Promise.allSettled(pending);
    if (failed) throw failure;
    for (const result of settled) {
      if (result.status === "fulfilled") results.push(result.value);
    }
  }
  if (signal.aborted) throw signal.reason;
  return results;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch((error) => swallow("security screen response cancel", error));
}

async function responseText(response: Response): Promise<string> {
  const text = await readCappedText(
    response,
    MAX_SECURITY_SCREEN_RESPONSE_BYTES,
    () => new Error("Security screen proxy response exceeds the supported limit"),
  );
  return text ?? "";
}

function classification(body: string, provider: string): SecurityScreenClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Security screen proxy returned invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Security screen proxy returned an invalid classification");
  }
  const result = parsed as Record<string, unknown>;
  const score = result.score;
  const threshold = result.threshold;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1 ||
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new Error("Security screen proxy returned invalid scores");
  }
  const outcome = result.primary_outcome;
  if (outcome !== undefined && (typeof outcome !== "string" || !OUTCOME.test(outcome))) {
    throw new Error("Security screen proxy returned an invalid outcome");
  }
  const malicious = score >= threshold;
  return {
    verdict: malicious
      ? { decision: "strict", reason: `${provider}:${typeof outcome === "string" ? outcome : "malicious"}` }
      : { decision: "auto" },
    score,
    threshold,
    ...(typeof outcome === "string" ? { outcome } : {}),
  };
}

export function createSecurityScreenProxy(opts: {
  provider: string;
  endpoint: string;
  token: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}): SecurityScreener {
  const request = opts.fetch ?? fetch;
  return {
    provider: opts.provider,
    async classify(input) {
      if (input.payload.length > MAX_SCREEN_CHARS) {
        throw new Error("Security screen proxy payload exceeds the supported limit");
      }
      const chunks = securityScreenChunks(input.payload);
      const requestId = input.requestId ?? randomUUID();
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const classifications = await classifyChunks(
        chunks,
        async (chunk, index, chunkSignal) => {
          const coordinates = {
            request_id: requestId,
            input_index: 0,
            chunk_index: index,
            chunk_count: chunks.length,
          };
          const body = JSON.stringify({
            text: chunk,
            hook: input.hook,
            metadata: {
              ...input.metadata,
              qm: coordinates,
              ...(opts.provider === "qm" ? {} : { [opts.provider]: coordinates }),
            },
          });
          const response = await fetchWithRetry(
            (attemptSignal) =>
              request(opts.endpoint, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": opts.token,
                },
                body,
                redirect: "error",
                signal: attemptSignal,
              }),
            "refused",
            { signal: chunkSignal, timeoutMs: opts.timeoutMs, baseDelayMs: SECURITY_SCREEN_RETRY_BASE_MS },
          );
          if (!response.ok) {
            await cancelResponseBody(response);
            throw new Error(`Security screen proxy returned HTTP ${response.status}`);
          }
          return classification(await responseText(response), opts.provider);
        },
        signal,
      );
      return classifications.reduce((highest, current) => {
        if (current.verdict.decision !== highest.verdict.decision) {
          return current.verdict.decision === "strict" ? current : highest;
        }
        return current.score > highest.score ? current : highest;
      });
    },
  };
}
