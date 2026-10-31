import { createHash } from "node:crypto";
import { orgId } from "../config.ts";
import { McpCallError } from "../mcp/mcp-client.ts";
import { TimeoutError } from "../util/async.ts";
import { swallow } from "../util/errors.ts";
import { UNATTESTABLE_ACTOR_FIX, UnattestableActor } from "../directory/person.ts";
import { MemoryRecallWithheld } from "./disclosure.ts";
import type { ScopeId } from "../types.ts";
import type { MemoryCaptureContext, MemoryProviderOutcome, MemoryService } from "./memory-service.ts";

const DENIED_CODES = new Set(["actor_not_attested", "actor_unlinked", "argument_mismatch"]);
const TROUBLESHOOTING = "docs/memory-providers.md#troubleshooting";

export function failedOutcome(error: unknown): Pick<MemoryProviderOutcome, "outcome" | "code"> {
  if (error instanceof MemoryRecallWithheld) return { outcome: "denied", code: "withheld" };
  if (error instanceof UnattestableActor) return { outcome: "denied", code: error.code };
  if (error instanceof TimeoutError) return { outcome: "timed_out" };
  if (!(error instanceof McpCallError)) return { outcome: "failed" };
  const code = error.code ?? (error.status ? `http_${error.status}` : undefined);
  const denied = error.status === 401 || error.status === 403 || DENIED_CODES.has(error.code ?? "");
  return { outcome: denied ? "denied" : "failed", ...(code ? { code } : {}) };
}

export interface MemoryProviderProblem {
  code: "memory_provider_denied" | "memory_provider_timeout" | "memory_provider_failed";
  provider: string;
  detail: string;
  fix: string;
  sideEffects?: "none" | "unknown";
}

function deniedFix(provider: string, code: string | undefined): string {
  if (code === "invalid_actor") return UNATTESTABLE_ACTOR_FIX;
  if (code === "actor_unlinked") return `Link this member's QM principal id to their member in ${provider}.`;
  return `Check ${provider}'s OAuth client and its grant, including the attest right when attestActor is set (${TROUBLESHOOTING}).`;
}

export function providerProblems(outcomes: readonly MemoryProviderOutcome[], write = false): MemoryProviderProblem[] {
  return outcomes.flatMap(({ provider, outcome, ms, code }): MemoryProviderProblem[] => {
    const reason = code ? ` (${code})` : "";
    if (outcome === "denied" && code !== "withheld")
      return [
        {
          code: "memory_provider_denied",
          provider,
          detail: `Memory provider ${provider} refused the request${reason}${write ? "; it stored nothing" : ""}.`,
          fix: deniedFix(provider, code),
          ...(write ? { sideEffects: "none" as const } : {}),
        },
      ];
    if (outcome === "timed_out" || outcome === "unknown")
      return [
        {
          code: "memory_provider_timeout",
          provider,
          detail: write
            ? `Memory provider ${provider} timed out after ${ms}ms, so whether it stored the facts is unknown; QM did not retry.`
            : `Memory provider ${provider} timed out after ${ms}ms, so its results are missing.`,
          fix: `Raise ${provider}'s timeoutMs in MEMORY_PROVIDER_CONFIG or check the provider's latency.`,
          ...(write ? { sideEffects: "unknown" as const } : {}),
        },
      ];
    if (outcome === "failed")
      return [
        {
          code: "memory_provider_failed",
          provider,
          detail: write
            ? `Memory provider ${provider} failed${reason}, so whether it stored the facts is unknown; QM did not retry.`
            : `Memory provider ${provider} failed${reason}, so its results are missing.`,
          fix: `Check ${provider}'s logs, URL and tool names (${TROUBLESHOOTING}).`,
          ...(write ? { sideEffects: "unknown" as const } : {}),
        },
      ];
    return [];
  });
}

export const problemLine = (problem: MemoryProviderProblem) =>
  `[${problem.code}] ${problem.detail} Fix: ${problem.fix}`;

function writeKey(turn: string, facts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([orgId(), turn, facts]))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function writeFacts(
  memory: MemoryService,
  scope: ScopeId,
  facts: string[],
  author: string | undefined,
  context: MemoryCaptureContext,
  turn: string | undefined,
): Promise<{ added: number; outcomes: MemoryProviderOutcome[] }> {
  const outcomes: MemoryProviderOutcome[] = [];
  const report = (outcome: MemoryProviderOutcome) => void outcomes.push(outcome);
  const keyed = turn ? { ...context, idempotencyKey: writeKey(turn, facts) } : context;
  try {
    return { added: await memory.capture(scope, facts, Date.now(), author, { ...keyed, report }), outcomes };
  } catch (error) {
    if (!providerProblems(outcomes, true).length) throw error;
    swallow("memory: explicit write", error);
    return { added: Math.max(0, ...outcomes.map((outcome) => outcome.added ?? 0)), outcomes };
  }
}
