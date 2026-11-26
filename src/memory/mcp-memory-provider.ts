import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CATALOG_MAX_TOOLS,
  McpCallError,
  mcpEnvelope,
  mcpResultText,
  metaWarnings,
  providerCode,
  toolListings,
  type McpClient,
} from "../mcp/mcp-client.ts";
import { TimeoutError, withTimeout } from "../util/async.ts";
import { reportFailureAs } from "../util/errors.ts";
import { attestedPerson, attestedActorHeaders, OutsideAudience, ownPrivateConversation } from "../directory/person.ts";
import { MemoryRecallWithheld } from "./disclosure.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import { factHash, type MemoryCandidate } from "./facts.ts";
import {
  DENIED_CODES,
  failedOutcome,
  MAX_FACTS_PER_WRITE,
  MemoryWriteUnconfirmed,
  reportEnvelope,
  requestKey,
} from "./provider-outcome.ts";
import type { McpMemoryOperationConfig } from "./provider-config.ts";
import { RECALL_MESSAGE_CHARS } from "./semantic-recall.ts";
import { flatText } from "../util/text.ts";

const MAX_PROVENANCE_CHARS = 200;

export type McpMemoryOperation = Omit<McpMemoryOperationConfig, "auth"> & { client: McpClient; timeoutMs: number };

const ACTING_USER = "acting_user";
const WRITE_RECEIPT_TOOL = "get_write_request";
const PENDING_STATES = new Set(["queued", "running", "recovering"]);
const UNPUBLISHED_STATES = new Set(["conflict", "failed", "cancelled"]);

export function lookupText(result: CallToolResult): string {
  return [mcpResultText(result), ...metaWarnings(result)].filter(Boolean).join("\n");
}

function refuseDenied(result: CallToolResult, tool: string, { quote }: { quote: boolean }): void {
  const { code } = mcpEnvelope(result);
  if (!code || !DENIED_CODES.has(code)) return;
  if (!quote) throw new McpCallError(`memory provider refused ${tool} (${code})`, { code, answered: true });
  throw new McpCallError(`memory provider refused ${tool} (${code}): ${mcpResultText(result)}`, {
    code,
    answered: true,
    warnings: metaWarnings(result),
  });
}

interface ProviderFact {
  id: string;
  text: string;
  date?: unknown;
  kind?: unknown;
}

function providerFacts(result: CallToolResult): ProviderFact[] | undefined {
  const facts = (result.structuredContent as { facts?: unknown } | undefined)?.facts;
  if (facts === undefined) return undefined;
  if (!Array.isArray(facts))
    throw new McpCallError(`memory provider returned facts as ${facts === null ? "null" : typeof facts}, not a list`, {
      code: "malformed_fact",
    });
  facts.forEach((fact: Partial<ProviderFact> | null, index) => {
    if (typeof fact?.id !== "string" || typeof fact.text !== "string")
      throw new McpCallError(
        `memory provider returned fact ${index} with id ${typeof fact?.id} and text ${typeof fact?.text}; both must be strings`,
        { code: "malformed_fact" },
      );
    if (!fact.id || /[\s\u0085]/.test(fact.id))
      throw new McpCallError(`memory provider returned fact ${index} with an id that is empty or holds whitespace`, {
        code: "malformed_fact",
      });
  });
  return (facts as ProviderFact[]).map((fact) => ({ ...fact, text: flatText(fact.text) })).filter((fact) => fact.text);
}

const stamped = (fact: ProviderFact) => {
  const stamp = [fact.date, fact.kind]
    .filter((part) => typeof part === "string")
    .map(flatText)
    .filter(Boolean)
    .join("; ");
  return stamp ? `(${stamp}) ${fact.text}` : fact.text;
};

export function createMcpMemoryProvider(
  opts: {
    read: McpMemoryOperation;
    write?: McpMemoryOperation;
    forget?: McpMemoryOperation;
    label?: string;
  } & ({ attestActor?: false } | { attestActor: true; url: string }),
): MemoryService {
  const attest = (actorId: string | undefined, scopeId: string, audienceScopeId: string | undefined) => {
    const person = opts.attestActor ? attestedPerson(actorId, "memory provider") : actorId;
    if (opts.attestActor && !ownPrivateConversation(actorId, scopeId, audienceScopeId))
      throw new OutsideAudience("memory provider");
    return { person, headers: opts.attestActor && person ? attestedActorHeaders(person) : undefined };
  };

  const listings = toolListings();
  const memoryTools = new Set([opts.read.tool, opts.write?.tool, opts.forget?.tool, WRITE_RECEIPT_TOOL]);
  const label = `memory provider ${opts.label}: tools/list`;
  const lookupTools = async (
    scopeId: string,
    actorId: string | undefined,
    audienceScopeId: string | undefined,
    allowStale: boolean,
  ) => {
    const { person, headers } = attest(actorId, scopeId, audienceScopeId);
    const listed = await listings
      .fetch(person!, {
        allowStale,
        context: {
          label,
          list: () =>
            opts.read.client
              .listTools({
                headers: headers!,
                maxTools: CATALOG_MAX_TOOLS,
                signal: AbortSignal.timeout(opts.read.timeoutMs),
              })
              .then(
                ({ tools }) => tools,
                (error: unknown) => {
                  if (failedOutcome(error).outcome !== "denied") throw error;
                  return reportFailureAs(label, [])(error);
                },
              ),
        },
      })
      .catch((error: unknown) => {
        if (!allowStale) throw error;
        listings.set(person!, []);
        return [];
      });
    return (listed ?? []).filter((tool) => tool.annotations?.readOnlyHint === true && !memoryTools.has(tool.name));
  };

  const call = async (
    op: Pick<McpMemoryOperation, "client" | "tool" | "timeoutMs">,
    args: Record<string, unknown>,
    actorArgs: readonly string[],
    actorId: string | undefined,
    scopeId: string,
    audienceScopeId: string | undefined,
    deadline: number | undefined,
    signal?: AbortSignal,
  ) => {
    const { person, headers } = attest(actorId, scopeId, audienceScopeId);
    if (person) for (const arg of actorArgs) args[arg] = person;
    const stop = new AbortController();
    const send = () =>
      op.client.callTool(op.tool, args, headers, signal ? AbortSignal.any([stop.signal, signal]) : stop.signal);
    const ms = deadline === undefined ? undefined : deadline - Date.now();
    if (ms !== undefined && ms <= 0) throw new TimeoutError(`memory provider timed out after ${op.timeoutMs}ms`);
    const result = await (ms === undefined ? send() : withTimeout(send, ms, "memory provider")).finally(() =>
      stop.abort(),
    );
    reportEnvelope(mcpEnvelope(result));
    return result;
  };

  const read = async (scopeId: string, query: string, context?: MemoryRecallContext): Promise<CallToolResult> => {
    const op = opts.read;
    const question = context?.input?.trim().slice(0, RECALL_MESSAGE_CHARS) || query;
    const args: Record<string, unknown> = { [op.queryArg ?? "query"]: question };
    if (op.scopeArg) args[op.scopeArg] = scopeId;
    const maxChars = context?.maxChars;
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars;
    const result = await call(
      op,
      args,
      [op.actorArg ?? ACTING_USER],
      context?.actorId,
      scopeId,
      context?.audienceScopeId,
      (context?.startedAt ?? Date.now()) + op.timeoutMs,
    ).catch((error: unknown) => {
      throw error instanceof OutsideAudience ? new MemoryRecallWithheld(scopeId) : error;
    });
    if (mcpEnvelope(result).code === "actor_unlinked") return { content: [] };
    refuseDenied(result, op.tool, { quote: false });
    return result;
  };

  const rows = (result: CallToolResult, maxChars: number | undefined, bullet: string): MemoryCandidate[] => {
    const facts = providerFacts(result);
    if (!facts) {
      const text = mcpResultText(result);
      return (maxChars && text.length > maxChars ? text.slice(0, maxChars) : text)
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => ({ text: line }));
    }
    const fitting: MemoryCandidate[] = [];
    let room = (maxChars || Infinity) + 1;
    for (const fact of facts) {
      const text = `${bullet}${stamped(fact)}`;
      if (text.length + 1 > room) continue;
      room -= text.length + 1;
      fitting.push({ ref: fact.id, claim: fact.text, text });
    }
    return fitting;
  };

  return {
    attestActor: opts.attestActor ?? false,
    async recall(scopeId, context) {
      const result = await read(scopeId, context?.query ?? "", context);
      return rows(result, context?.maxChars, "- ");
    },

    async capture(scopeId, facts, at, by, context) {
      const op = opts.write;
      if (!op) throw new Error("memory provider write is not configured");
      const actor = by?.actorId;
      const provenance = (context?.conversationScopeId ?? scopeId).slice(0, MAX_PROVENANCE_CHARS);
      const size = op.factsArg ? MAX_FACTS_PER_WRITE : facts.length;
      const deadline = Date.now() + op.timeoutMs;
      for (let start = 0; start < facts.length; start += size) {
        const batch = facts.slice(start, start + size);
        const args: Record<string, unknown> = op.factsArg
          ? { [op.factsArg]: batch.map((fact) => ({ fact, provenance })) }
          : { [op.contentArg ?? "content"]: batch.join("\n") };
        if (!start && context?.input && op.inputArg) args[op.inputArg] = context.input;
        if (!start && context?.reply && op.replyArg) args[op.replyArg] = context.reply;
        if (op.capturedAtArg) args[op.capturedAtArg] = at;
        if (op.sourceArg) args[op.sourceArg] = context?.mode ?? "explicit";
        if (context?.idempotencyKey && op.idempotencyArg)
          args[op.idempotencyArg] = start ? `${context.idempotencyKey}:${start / size}` : context.idempotencyKey;
        if (op.scopeArg) args[op.scopeArg] = scopeId;
        refuseDenied(
          await call(op, args, [op.actorArg ?? ACTING_USER], actor, scopeId, context?.audienceScopeId, deadline),
          op.tool,
          { quote: false },
        );
      }
      return facts.length;
    },

    async query(scopeId, q, limit = 20, context) {
      const result = await read(scopeId, q, context);
      return rows(result, context?.maxChars, "").slice(0, limit);
    },

    read: async (scopeId) => mcpResultText(await read(scopeId, "")),

    ...(opts.attestActor
      ? {
          brain: { endpoint: factHash(opts.url).slice(0, 16), timeoutMs: opts.read.timeoutMs },
          lookupTools: (scopeId, { actorId, audienceScopeId }, { allowStale }) =>
            lookupTools(scopeId, actorId, audienceScopeId, allowStale),
          lookup: async (scopeId, tool, args, by, context) => {
            const result = await call(
              { ...opts.read, tool },
              { ...args },
              [opts.read.actorArg ?? ACTING_USER, ACTING_USER].filter((arg) => Object.hasOwn(args, arg)),
              by?.actorId,
              scopeId,
              context?.audienceScopeId,
              context?.startedAt === undefined ? undefined : context.startedAt + opts.read.timeoutMs,
              context?.signal,
            );
            refuseDenied(result, tool, { quote: true });
            return result;
          },
        }
      : {}),

    ...(opts.forget
      ? {
          async delete(scopeId, ids, by, context) {
            const op = opts.forget!;
            const deadline = (context?.startedAt ?? Date.now()) + op.timeoutMs;
            for (const id of ids) {
              const factId = Number(id);
              if (!Number.isSafeInteger(factId) || factId < 0 || String(factId) !== id)
                throw new McpCallError(`memory provider fact ids are whole numbers, not ${JSON.stringify(id)}`, {
                  code: "fact_not_found",
                });
              const args: Record<string, unknown> = { id: factId };
              if (context?.idempotencyKey && op.idempotencyArg)
                args[op.idempotencyArg] = requestKey(context.idempotencyKey, id);
              const result = await call(op, args, [], by?.actorId, scopeId, context?.audienceScopeId, deadline).catch(
                (error: unknown) => {
                  if (error instanceof McpCallError && error.code === "fact_already_expired") return undefined;
                  throw error;
                },
              );
              if (!result) continue;
              const state = (result.structuredContent as { state?: unknown } | undefined)?.state;
              if (state === "committed") continue;
              if (typeof state === "string" && UNPUBLISHED_STATES.has(state))
                throw new McpCallError(`memory provider ${op.tool} ended ${state}: ${mcpResultText(result)}`, {
                  code: state,
                });
              if (typeof state !== "string" || !PENDING_STATES.has(state))
                throw new MemoryWriteUnconfirmed(providerCode(state) ?? "no_state", mcpResultText(result));
              reportEnvelope({ status: "pending", code: state });
            }
          },
        }
      : {}),
  };
}
