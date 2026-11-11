import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { orgId } from "../config.ts";
import { McpCallError, type McpEnvelope } from "../mcp/mcp-client.ts";
import { TimeoutError } from "../util/async.ts";
import { reportFailure } from "../util/errors.ts";
import { OutsideAudience, UNATTESTABLE_ACTOR_FIX, UnattestableActor } from "../directory/person.ts";
import type { ScopeId } from "../types.ts";
import type {
  MemoryAuthority,
  MemoryCaptureContext,
  MemoryForgetContext,
  MemoryProviderOutcome,
  MemoryService,
} from "./memory-service.ts";

export const DENIED_CODES: ReadonlySet<string> = new Set([
  "actor_not_attested",
  "actor_unlinked",
  "argument_mismatch",
  "scope_denied",
  "insufficient_scope",
  "permission_denied",
]);
export const MAX_FACTS_PER_WRITE = 20;
const TROUBLESHOOTING = "docs/memory-providers.md#troubleshooting";
const FORGET_DOCS = "docs/memory-providers.md#forgetting-a-brain-fact";

const envelopes = new AsyncLocalStorage<(envelope: McpEnvelope) => void>();

export const reportEnvelope = (envelope: McpEnvelope) => envelopes.getStore()?.(envelope);

export async function withEnvelope<T>(run: () => Promise<T>): Promise<{ value: T; envelope: McpEnvelope }> {
  let envelope: McpEnvelope = {};
  const value = await envelopes.run(
    (received) => void (envelope = envelope.status === "pending" ? { ...received, status: "pending" } : received),
    run,
  );
  return { value, envelope };
}

export class MemoryProviderDisabled extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`memory provider is disabled (${code})`);
    this.code = code;
  }
}

export class MemoryWriteUnconfirmed extends Error {
  readonly code: string;
  constructor(code: string, reply?: string) {
    super(`memory provider didn't confirm the write (${code})${reply ? `: ${reply}` : ""}`);
    this.code = code;
  }
}

export function failedOutcome(error: unknown): Pick<MemoryProviderOutcome, "outcome" | "code"> {
  if (error instanceof MemoryProviderDisabled) return { outcome: "disabled", code: error.code };
  if (error instanceof UnattestableActor || error instanceof OutsideAudience)
    return { outcome: "denied", code: error.code };
  if (error instanceof TimeoutError) return { outcome: "timed_out" };
  if (!(error instanceof McpCallError)) return { outcome: "failed" };
  const code = error.code ?? (error.status ? `http_${error.status}` : undefined);
  const denied = error.status === 401 || error.status === 403 || DENIED_CODES.has(error.code ?? "");
  return { outcome: denied ? "denied" : "failed", ...(code ? { code } : {}) };
}

export function changeFailure(error: unknown): Pick<MemoryProviderOutcome, "outcome" | "code"> {
  if (error instanceof MemoryWriteUnconfirmed) return { outcome: "unknown", code: error.code };
  const failed = failedOutcome(error);
  if (failed.outcome === "timed_out") return { outcome: "unknown" };
  if (!(error instanceof McpCallError) || failed.outcome !== "failed" || error.code !== undefined || error.answered)
    return failed;
  if (error.unsent) return { outcome: "failed", code: failed.code ?? "unreachable" };
  return { outcome: "unknown", ...(failed.code ? { code: failed.code } : {}) };
}

export interface MemoryProviderProblem {
  code:
    | "memory_provider_denied"
    | "memory_provider_timeout"
    | "memory_provider_failed"
    | "memory_provider_disabled"
    | "memory_provider_unknown";
  provider: string;
  detail: string;
  fix: string;
}

function deniedFix(provider: string, code: string | undefined): string {
  if (code === "invalid_actor") return UNATTESTABLE_ACTOR_FIX;
  if (code === "private_only")
    return `Save it from the member's own private conversation with QM, the only place ${provider} acts as them.`;
  if (code === "actor_unlinked") return `Link this member's QM principal id to their member in ${provider}.`;
  return `Check ${provider}'s OAuth client and its grant, including the attest right when attestActor is set (${TROUBLESHOOTING}).`;
}

function failedFix(provider: string, code: string | undefined, docs: string): string {
  if (code === "unreachable") return `Check that ${provider}'s host is up and reachable from QM (${docs}).`;
  if (code === "fact_not_found")
    return `${provider} forgets only facts on the person's own member page; search memory again for current refs.`;
  return `Check ${provider}'s logs, URL and tool names (${docs}).`;
}

type ProblemGroup = MemoryProviderOutcome & { refs: string[] };

function problemOf(group: ProblemGroup, operation: ProviderOperation): MemoryProviderProblem | undefined {
  const { provider, ms, code } = group;
  const refs = group.refs.join(", ");
  const it = group.refs.length > 1 ? "them" : "it";
  const reason = code ? ` (${code})` : "";
  const forget = operation === "forget";
  const docs = forget ? FORGET_DOCS : TROUBLESHOOTING;
  const asked = forget ? `to forget ${refs}` : "the request";
  const effect = {
    search: "its results are missing",
    write: "it stored nothing",
    forget: "this call changed nothing there",
  }[operation];
  switch (group.outcome) {
    case "denied":
      return {
        code: "memory_provider_denied",
        provider,
        detail: `Memory provider ${provider} refused ${asked}${reason}${operation === "search" ? "" : `, so ${effect}`}.`,
        fix:
          forget && code === "actor_not_attested"
            ? `On ${provider}'s host, let QM's client attest forgetting with --attest-ops (${FORGET_DOCS}).`
            : deniedFix(provider, code),
      };
    case "timed_out":
      return {
        code: "memory_provider_timeout",
        provider,
        detail: `Memory provider ${provider} timed out after ${ms}ms, so its results are missing.`,
        fix: `Raise ${provider}'s timeoutMs in MEMORY_PROVIDER_CONFIG or check its latency.`,
      };
    case "unknown":
      return {
        code: "memory_provider_unknown",
        provider,
        detail: `Memory provider ${provider} didn't confirm ${forget ? `that it forgot ${refs}` : "the write"}${code ? reason : ` within ${ms}ms`}, so whether it ${forget ? "did" : "stored the facts"} is unknown; QM did not retry.`,
        fix: `Check ${provider}'s logs before ${forget ? `deleting ${it}` : "sending the facts"} again (${docs}).`,
      };
    case "failed":
      return {
        code: "memory_provider_failed",
        provider,
        detail: `Memory provider ${provider} failed${forget ? ` to forget ${refs}` : ""}${reason}, so ${effect}.`,
        fix: failedFix(provider, code, docs),
      };
    case "disabled":
      return {
        code: "memory_provider_disabled",
        provider,
        detail: `Memory provider ${provider} is registered for this scope but not serving it${reason}, so QM didn't call it.`,
        fix: `Look up ${code ?? "the code"} in docs/memory-providers.md#memory-registry; GET /v1/admin/memory-registry shows the entry.`,
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

type ProviderOperation = "search" | "write" | "forget";

export async function withProviders<T>(
  operation: ProviderOperation,
  run: (report: OutcomeReport) => Promise<T>,
): Promise<MemoryProviderReport<T>> {
  const outcomes: MemoryProviderOutcome[] = [];
  const problems = () =>
    [
      ...Map.groupBy(
        outcomes.filter(({ provider }) => provider !== "default"),
        ({ ref, provider, outcome, code }, index) => (ref ? JSON.stringify([provider, outcome, code]) : index),
      ).values(),
    ].flatMap((group) => problemOf({ ...group[0]!, refs: group.flatMap(({ ref }) => ref ?? []) }, operation) ?? []);
  try {
    const value = await run((outcome) => void outcomes.push(outcome));
    return { value, outcomes, problems: problems() };
  } catch (error) {
    const notebookFailed = outcomes.some(
      (outcome) => outcome.provider === "default" && problemOf({ ...outcome, refs: [] }, operation),
    );
    if (notebookFailed || !problems().length || !strictFailures.has(error as object)) throw error;
    reportFailure(`memory: provider ${operation}`, error);
    return { outcomes, problems: problems() };
  }
}

export function requestKey(...parts: unknown[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([orgId(), ...parts]))
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
  by: MemoryAuthority,
  context: MemoryCaptureContext,
  turn: string | undefined,
): Promise<MemoryWrite> {
  const idempotencyKey = requestKey(turn ?? randomUUID(), scope, facts);
  const { value, outcomes, problems } = await withProviders("write", (report) =>
    memory.capture(scope, facts, Date.now(), by, { ...context, idempotencyKey, report }),
  );
  return { added: value ?? Math.max(0, ...outcomes.map(({ added }) => added ?? 0)), outcomes, problems };
}

export interface MemoryForget {
  forgotten: number;
  outcomes: MemoryProviderOutcome[];
  problems: MemoryProviderProblem[];
}

export async function forgetFacts(
  memory: MemoryService,
  scope: ScopeId,
  ids: string[],
  by: MemoryAuthority,
  context: Pick<MemoryForgetContext, "audienceScopeId">,
  call: string | undefined,
): Promise<MemoryForget> {
  const idempotencyKey = requestKey("forget", call ?? randomUUID(), scope);
  const { outcomes, problems } = await withProviders("forget", (report) =>
    memory.delete!(scope, ids, by, { ...context, idempotencyKey, report }),
  );
  const forgotten = ids.length - outcomes.filter(({ outcome }) => outcome !== "committed").length;
  return { forgotten, outcomes, problems };
}
