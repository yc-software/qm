import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpCallError, mcpEnvelope, mcpResultText, type McpClient } from "../mcp/mcp-client.ts";
import { sleep, TimeoutError, withTimeout } from "../util/async.ts";
import { attestableAudience, attestedPerson, OutsideAudience } from "../directory/person.ts";
import { MemoryRecallWithheld } from "./disclosure.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import type { MemoryCandidate } from "./facts.ts";
import {
  DENIED_CODES,
  failedOutcome,
  MAX_FACTS_PER_WRITE,
  MemoryWriteUnconfirmed,
  reportEnvelope,
  requestKey,
} from "./provider-outcome.ts";
import type { McpMemoryForgetConfig, McpMemoryOperationConfig } from "./provider-config.ts";
import { RECALL_MESSAGE_CHARS } from "./semantic-recall.ts";
import { flatText } from "../util/text.ts";

const MAX_PROVENANCE_CHARS = 200;

export type McpMemoryOperation = Omit<McpMemoryOperationConfig, "auth"> & { client: McpClient; timeoutMs: number };
export type McpMemoryForget = Omit<McpMemoryForgetConfig, "auth"> & { client: McpClient; timeoutMs: number };

const UNPUBLISHED_STATES = new Set(["conflict", "failed", "cancelled"]);

interface ForgetReceipt {
  state?: unknown;
  retry_after_ms?: unknown;
}

function resultText(result: CallToolResult): string {
  if (result.content.some((block) => block.type === "text")) return mcpResultText(result);
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
}

interface ProviderFact {
  id: string;
  text: string;
  date?: unknown;
  kind?: unknown;
  arm?: unknown;
}

function alternateArms(facts: ProviderFact[]): ProviderFact[] {
  const own = facts.filter((fact) => fact.arm === "own");
  const ranked = facts.filter((fact) => fact.arm !== "own");
  return Array.from({ length: Math.max(own.length, ranked.length) }, (_, i) => [own[i], ranked[i]])
    .flat()
    .filter((fact) => fact !== undefined);
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
  return alternateArms(
    (facts as ProviderFact[]).map((fact) => ({ ...fact, text: flatText(fact.text) })).filter((fact) => fact.text),
  );
}

const stamped = (fact: ProviderFact) => {
  const stamp = [fact.date, fact.kind]
    .filter((part) => typeof part === "string")
    .map(flatText)
    .filter(Boolean)
    .join("; ");
  return stamp ? `(${stamp}) ${fact.text}` : fact.text;
};

export function createMcpMemoryProvider(opts: {
  read: McpMemoryOperation;
  write?: McpMemoryOperation;
  forget?: McpMemoryForget;
  attestActor?: boolean;
}): MemoryService {
  const call = async (
    op: Pick<McpMemoryOperation, "client" | "tool" | "timeoutMs">,
    args: Record<string, unknown>,
    actorArg: string | undefined,
    actorId: string | undefined,
    scopeId: string,
    audienceScopeId: string | undefined,
    deadline = Date.now() + op.timeoutMs,
  ) => {
    const person = opts.attestActor ? attestedPerson(actorId, "memory provider") : actorId;
    if (opts.attestActor && !(attestableAudience(actorId, scopeId) && attestableAudience(actorId, audienceScopeId)))
      throw new OutsideAudience("memory provider");
    if (person && actorArg) args[actorArg] = person;
    const headers = opts.attestActor && person ? { "x-qm-actor": person } : undefined;
    const ms = deadline - Date.now();
    if (ms <= 0) throw new TimeoutError(`memory provider timed out after ${op.timeoutMs}ms`);
    const stop = new AbortController();
    const result = await withTimeout(
      () => op.client.callTool(op.tool, args, headers, stop.signal),
      ms,
      "memory provider",
    ).finally(() => stop.abort());
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
      op.actorArg ?? "acting_user",
      context?.actorId,
      scopeId,
      context?.audienceScopeId,
    ).catch((error: unknown) => {
      throw error instanceof OutsideAudience ? new MemoryRecallWithheld(scopeId) : error;
    });
    const { code } = mcpEnvelope(result);
    if (code === "actor_unlinked") return { content: [] };
    if (code && DENIED_CODES.has(code)) throw new McpCallError(`memory provider refused the read (${code})`, { code });
    return result;
  };

  const rows = (result: CallToolResult, maxChars: number | undefined, bullet: string): MemoryCandidate[] => {
    const facts = providerFacts(result);
    if (!facts) {
      const text = resultText(result);
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
        const { code } = mcpEnvelope(
          await call(op, args, op.actorArg ?? "acting_user", actor, scopeId, context?.audienceScopeId, deadline),
        );
        if (code && DENIED_CODES.has(code))
          throw new McpCallError(`memory provider refused the write (${code})`, { code });
      }
      return facts.length;
    },

    async query(scopeId, q, limit = 20, context) {
      const result = await read(scopeId, q, context);
      return rows(result, context?.maxChars, "").slice(0, limit);
    },

    read: async (scopeId) => resultText(await read(scopeId, "")),

    ...(opts.forget
      ? {
          async delete(scopeId, ids, by, context) {
            const op = opts.forget!;
            for (const id of ids) {
              const factId = Number(id);
              if (!/^\d+$/.test(id) || !Number.isSafeInteger(factId))
                throw new McpCallError(`memory provider fact ids are whole numbers, not ${JSON.stringify(id)}`, {
                  code: "fact_not_found",
                });
              const deadline = Date.now() + op.timeoutMs;
              const requestId = requestKey(context?.idempotencyKey ?? randomUUID(), id);
              const send = async (tool: string, args: Record<string, unknown>): Promise<ForgetReceipt> =>
                (
                  await call(
                    { ...op, tool },
                    { ...args, [op.requestIdArg]: requestId },
                    undefined,
                    by?.actorId,
                    scopeId,
                    context?.audienceScopeId,
                    deadline,
                  )
                ).structuredContent ?? {};
              const receipt = (pending: string) =>
                send(op.receiptTool, {}).catch((error: unknown) => {
                  throw new MemoryWriteUnconfirmed(pending, error);
                });
              let reply: ForgetReceipt;
              let polled = false;
              try {
                reply = await send(op.tool, { [op.idArg]: factId });
              } catch (error) {
                if (!(error instanceof McpCallError) || error.code !== undefined || error.unsent) throw error;
                reply = await receipt(failedOutcome(error).code ?? "no_reply");
                polled = true;
              }
              for (;;) {
                const { state, retry_after_ms: wait } = reply;
                if (state === "committed") break;
                if (typeof state === "string" && UNPUBLISHED_STATES.has(state))
                  throw new McpCallError(`memory provider ${op.tool} ended ${state}`, { code: state });
                const pending = typeof state === "string" ? state : "no_state";
                const delay = polled ? wait : 0;
                if (typeof delay !== "number" || (polled && delay <= 0) || Date.now() + delay >= deadline)
                  throw new MemoryWriteUnconfirmed(pending);
                await sleep(delay);
                reply = await receipt(pending);
                polled = true;
              }
            }
          },
        }
      : {}),
  };
}
