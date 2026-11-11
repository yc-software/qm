import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { orgId } from "../config.ts";
import { McpCallError, type McpEnvelope } from "../mcp/mcp-client.ts";
import { TimeoutError } from "../util/async.ts";
import { reportFailure } from "../util/errors.ts";
import { OutsideAudience, UNATTESTABLE_ACTOR_FIX, UnattestableActor } from "../directory/person.ts";
import type { ScopeId } from "../types.ts";
import { normalizeClaim, parseFactId, type MemoryCaptureMetadata } from "./facts.ts";
import {
  changesBrainAsPerson,
  type MemoryAuthority,
  type MemoryCaptureContext,
  type MemoryEdit,
  type MemoryForgetContext,
  type MemoryProviderOutcome,
  type MemoryRecallContext,
  type MemoryService,
} from "./memory-service.ts";

export const DENIED_CODES: ReadonlySet<string> = new Set([
  "actor_not_attested",
  "actor_unlinked",
  "argument_mismatch",
  "scope_denied",
  "insufficient_scope",
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
  constructor(code: string) {
    super(`memory provider didn't confirm the write (${code})`);
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

export function forgetFailure(error: unknown): Pick<MemoryProviderOutcome, "outcome" | "code"> {
  const failed = failedOutcome(error);
  if (failed.outcome === "denied" || (error instanceof McpCallError && error.code !== undefined)) return failed;
  if (error instanceof McpCallError && error.unsent) return { outcome: "failed", code: failed.code ?? "unreachable" };
  const code = error instanceof MemoryWriteUnconfirmed ? error.code : failed.code;
  return { outcome: "unknown", ...(code ? { code } : {}) };
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

function forgetProblem(outcome: MemoryProviderOutcome): MemoryProviderProblem | undefined {
  const { provider, ref, ms, code } = outcome;
  const reason = code ? ` (${code})` : "";
  switch (outcome.outcome) {
    case "denied":
      return {
        code: "memory_provider_denied",
        provider,
        detail: `Memory provider ${provider} refused to forget ${ref}${reason}, so nothing changed there.`,
        fix:
          code === "actor_not_attested"
            ? `On ${provider}'s host, list forget_fact in QM's client's --attest-ops (${FORGET_DOCS}).`
            : deniedFix(provider, code),
      };
    case "failed": {
      const fixes: Record<string, string> = {
        fact_not_found: `${provider} forgets only facts on the person's own member page; search memory again for current refs.`,
        unreachable: `Check that ${provider}'s host is up and reachable from QM, then delete it again (${FORGET_DOCS}).`,
      };
      return {
        code: "memory_provider_failed",
        provider,
        detail: `Memory provider ${provider} didn't forget ${ref}${reason}, so nothing changed there.`,
        fix: fixes[code ?? ""] ?? `Check ${provider}'s logs (${FORGET_DOCS}).`,
      };
    }
    case "unknown":
      return {
        code: "memory_provider_unknown",
        provider,
        detail: `Memory provider ${provider} didn't confirm that it forgot ${ref}${code ? ` (${code})` : ` within ${ms}ms`}, so whether it did is unknown.`,
        fix: `Search memory for it: if ${provider} still holds it, the search shows ${ref}, and deleting it again is safe.`,
      };
    default:
      return undefined;
  }
}

function problemOf(outcome: MemoryProviderOutcome, write: boolean): MemoryProviderProblem | undefined {
  const { provider, ms, code } = outcome;
  const reason = code ? ` (${code})` : "";
  if (write && code === "fact_withdrawn")
    return {
      code: "memory_provider_denied",
      provider,
      detail: `Memory provider ${provider} refused to save it again (fact_withdrawn), because it was asked to forget this exact claim, so it stored nothing.`,
      fix: `QM's notebook still saved it. ${provider} keeps a forgotten claim withdrawn; to have it there too, state it in other words.`,
    };
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
        fix: write
          ? `Check ${provider}'s latency, and whether it stored the facts before sending them again.`
          : `Raise ${provider}'s timeoutMs in MEMORY_PROVIDER_CONFIG or check its latency.`,
      };
    case "failed":
      return {
        code: "memory_provider_failed",
        provider,
        detail: `Memory provider ${provider} failed${reason}, so ${lost}.`,
        fix: `Check ${provider}'s logs, URL and tool names (${TROUBLESHOOTING}).`,
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

export async function withProviders<T>(
  operation: "search" | "write" | "forget",
  run: (report: OutcomeReport) => Promise<T>,
): Promise<MemoryProviderReport<T>> {
  const outcomes: MemoryProviderOutcome[] = [];
  const problems = () =>
    outcomes.flatMap((outcome) =>
      outcome.provider === "default"
        ? []
        : ((operation === "forget" ? forgetProblem(outcome) : problemOf(outcome, operation === "write")) ?? []),
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
  const forgotten = outcomes.length ? outcomes.filter(({ outcome }) => outcome === "committed").length : ids.length;
  return { forgotten, outcomes, problems };
}

export interface MemoryEdited {
  copies: string[];
  problems: MemoryProviderProblem[];
}

export async function editNotebookFacts(
  memory: MemoryService,
  scope: ScopeId,
  edits: MemoryEdit[],
  by: MemoryAuthority,
  context: MemoryCaptureMetadata & Pick<MemoryRecallContext, "audienceScopeId">,
): Promise<MemoryEdited> {
  const before = new Map(((await memory.facts?.(scope)) ?? []).map((fact) => [fact.id, fact.text]));
  await memory.edit!(scope, edits, by, context);
  if (!changesBrainAsPerson(by)) return { copies: [], problems: [] };
  const old = [...new Set(edits.flatMap((edit) => before.get(parseFactId(edit.id)) ?? []))];
  const audience = context.audienceScopeId ? { audienceScopeId: context.audienceScopeId } : {};
  const { value, problems } = await withProviders("search", (report) =>
    Promise.all(
      old.map(async (text) =>
        (await memory.query(scope, text, 20, { actorId: by.actorId, ...audience, report })).filter(
          (row) => row.ref !== undefined && normalizeClaim(row.claim ?? "") === normalizeClaim(text),
        ),
      ),
    ),
  );
  return { copies: [...new Set((value ?? []).flat().map((row) => row.ref!))], problems };
}
