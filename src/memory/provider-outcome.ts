import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { orgId } from "../config.ts";
import { McpCallError, type McpEnvelope } from "../mcp/mcp-client.ts";
import { TimeoutError } from "../util/async.ts";
import { reportFailure } from "../util/errors.ts";
import { UNATTESTABLE_ACTOR_FIX, UnattestableActor } from "../directory/person.ts";
import type { ScopeId } from "../types.ts";
import type { MemoryCaptureContext, MemoryProviderOutcome, MemoryService } from "./memory-service.ts";

export const DENIED_CODES: ReadonlySet<string> = new Set(["actor_not_attested", "actor_unlinked", "argument_mismatch"]);
const TROUBLESHOOTING = "docs/memory-providers.md#troubleshooting";

const envelopes = new AsyncLocalStorage<(envelope: McpEnvelope) => void>();

export const reportEnvelope = (envelope: McpEnvelope) => envelopes.getStore()?.(envelope);

export async function withEnvelope<T>(run: () => Promise<T>): Promise<{ value: T; envelope: McpEnvelope }> {
  let envelope: McpEnvelope = {};
  const value = await envelopes.run((received) => void (envelope = received), run);
  return { value, envelope };
}

export function failedOutcome(error: unknown): Pick<MemoryProviderOutcome, "outcome" | "code"> {
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
}

function deniedFix(provider: string, code: string | undefined): string {
  if (code === "invalid_actor") return UNATTESTABLE_ACTOR_FIX;
  if (code === "actor_unlinked") return `Link this member's QM principal id to their member in ${provider}.`;
  return `Check ${provider}'s OAuth client and its grant, including the attest right when attestActor is set (${TROUBLESHOOTING}).`;
}

function problemOf(outcome: MemoryProviderOutcome, write: boolean): MemoryProviderProblem | undefined {
  const { provider, ms, code } = outcome;
  const reason = code ? ` (${code})` : "";
  const lost = write ? "whether it stored the facts is unknown; QM did not retry" : "its results are missing";
  switch (outcome.outcome) {
    case "denied":
      return {
        code: "memory_provider_denied",
        provider,
        detail: `Memory provider ${provider} refused the request${reason}${write ? ", so it stored nothing" : ""}.`,
        fix: deniedFix(provider, code),
      };
    case "timed_out":
    case "unknown":
      return {
        code: "memory_provider_timeout",
        provider,
        detail: `Memory provider ${provider} timed out after ${ms}ms, so ${lost}.`,
        fix: `Raise ${provider}'s timeoutMs in MEMORY_PROVIDER_CONFIG or check its latency.`,
      };
    case "failed":
      return {
        code: "memory_provider_failed",
        provider,
        detail: `Memory provider ${provider} failed${reason}, so ${lost}.`,
        fix: `Check ${provider}'s logs, URL and tool names (${TROUBLESHOOTING}).`,
      };
    default:
      return undefined;
  }
}

export const problemLine = (problem: MemoryProviderProblem) =>
  `[${problem.code}] ${problem.detail} Fix: ${problem.fix}`;

export type OutcomeReport = (outcome: MemoryProviderOutcome) => void;

const strictFailures = new WeakSet<object>();

export function strictFailure(error: unknown): unknown {
  if (typeof error === "object" && error !== null) strictFailures.add(error);
  return error;
}

export interface MemoryProviderReport<T> {
  value?: T;
  outcomes: MemoryProviderOutcome[];
  problems: MemoryProviderProblem[];
}

export async function withProviders<T>(
  operation: "search" | "write",
  run: (report: OutcomeReport) => Promise<T>,
): Promise<MemoryProviderReport<T>> {
  const outcomes: MemoryProviderOutcome[] = [];
  const problems = () =>
    outcomes.flatMap((outcome) =>
      outcome.provider === "default" ? [] : (problemOf(outcome, operation === "write") ?? []),
    );
  try {
    const value = await run((outcome) => void outcomes.push(outcome));
    return { value, outcomes, problems: problems() };
  } catch (error) {
    const notebookFailed = outcomes.some((outcome) => outcome.provider === "default" && problemOf(outcome, false));
    if (notebookFailed || !problems().length || !strictFailures.has(error as object)) throw error;
    reportFailure(`memory: provider ${operation}`, error);
    return { outcomes, problems: problems() };
  }
}

function writeKey(turn: string, scope: ScopeId, facts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([orgId(), turn, scope, facts]))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface MemoryWrite {
  added: number;
  outcomes: MemoryProviderOutcome[];
  problems: MemoryProviderProblem[];
}

export async function writeFacts(
  memory: MemoryService,
  scope: ScopeId,
  facts: string[],
  author: string | undefined,
  context: MemoryCaptureContext,
  turn: string | undefined,
): Promise<MemoryWrite> {
  const keyed = turn ? { ...context, idempotencyKey: writeKey(turn, scope, facts) } : context;
  const { value, outcomes, problems } = await withProviders("write", (report) =>
    memory.capture(scope, facts, Date.now(), author, { ...keyed, report }),
  );
  return { added: value ?? Math.max(0, ...outcomes.map(({ added }) => added ?? 0)), outcomes, problems };
}
