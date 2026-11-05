import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpCallError, mcpEnvelope, mcpResultText, type McpClient } from "../mcp/mcp-client.ts";
import { TimeoutError, withTimeout } from "../util/async.ts";
import { attestableAudience, attestedPerson, OutsideAudience } from "../directory/person.ts";
import { MemoryRecallWithheld } from "./disclosure.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import { DENIED_CODES, MAX_FACTS_PER_WRITE, reportEnvelope } from "./provider-outcome.ts";
import type { McpMemoryOperationConfig } from "./provider-config.ts";
import { RECALL_MESSAGE_CHARS } from "./semantic-recall.ts";

const MAX_PROVENANCE_CHARS = 200;

export type McpMemoryOperation = Omit<McpMemoryOperationConfig, "auth"> & { client: McpClient; timeoutMs: number };

function resultText(result: CallToolResult): string {
  if (DENIED_CODES.has(mcpEnvelope(result).code ?? "")) return "";
  if (result.content.some((block) => block.type === "text")) return mcpResultText(result);
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
}

export function createMcpMemoryProvider(opts: {
  read: McpMemoryOperation;
  write?: McpMemoryOperation;
  attestActor?: boolean;
}): MemoryService {
  const call = async (
    op: McpMemoryOperation,
    args: Record<string, unknown>,
    actorId: string | undefined,
    scopeId: string,
    deadline = Date.now() + op.timeoutMs,
  ) => {
    const person = opts.attestActor ? attestedPerson(actorId, "memory provider") : actorId;
    if (opts.attestActor && !attestableAudience(actorId, scopeId)) throw new OutsideAudience("memory provider");
    if (person) args[op.actorArg ?? "acting_user"] = person;
    const headers = opts.attestActor && person ? { "x-qm-actor": person } : undefined;
    const ms = deadline - Date.now();
    if (ms <= 0) throw new TimeoutError(`memory provider timed out after ${op.timeoutMs}ms`);
    const result = await withTimeout(() => op.client.callTool(op.tool, args, headers), ms, "memory provider");
    reportEnvelope(mcpEnvelope(result));
    return result;
  };

  const read = async (scopeId: string, query: string, context?: MemoryRecallContext): Promise<string> => {
    const op = opts.read;
    const question = context?.input?.trim().slice(0, RECALL_MESSAGE_CHARS) || query;
    const args: Record<string, unknown> = { [op.queryArg ?? "query"]: question };
    if (op.scopeArg) args[op.scopeArg] = scopeId;
    const maxChars = context?.maxChars;
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars;
    const result = await call(op, args, context?.actorId, scopeId).catch((error: unknown) => {
      throw error instanceof OutsideAudience ? new MemoryRecallWithheld(scopeId) : error;
    });
    const { code } = mcpEnvelope(result);
    if (code && code !== "actor_unlinked" && DENIED_CODES.has(code))
      throw new McpCallError(`memory provider refused the read (${code})`, { code });
    const text = resultText(result);
    return maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
  };

  return {
    attestActor: opts.attestActor ?? false,
    async recall(scopeId, context) {
      const text = await read(scopeId, context?.query ?? "", context);
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => ({ text: line, score: 0.2 }));
    },

    async capture(scopeId, facts, at, author, context) {
      const op = opts.write;
      if (!op) throw new Error("memory provider write is not configured");
      const actor = opts.attestActor ? context?.actorId : (context?.actorId ?? author);
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
        const { code } = mcpEnvelope(await call(op, args, actor, scopeId, deadline));
        if (code && DENIED_CODES.has(code))
          throw new McpCallError(`memory provider refused the write (${code})`, { code });
      }
      return facts.length;
    },

    async query(scopeId, q, limit = 20, context) {
      const text = await read(scopeId, q, context);
      return text ? text.split("\n").filter(Boolean).slice(0, limit) : [];
    },

    read: (scopeId) => read(scopeId, ""),
  };
}
