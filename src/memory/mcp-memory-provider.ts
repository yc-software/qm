import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpCallError, mcpEnvelope, mcpResultText, type McpClient } from "../mcp/mcp-client.ts";
import { withTimeout } from "../util/async.ts";
import { attestedPerson } from "../directory/person.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import { DENIED_CODES, reportEnvelope } from "./provider-outcome.ts";

export interface McpMemoryOperation {
  client: McpClient;
  tool: string;
  queryArg?: string;
  contentArg?: string;
  actorArg?: string;
  scopeArg?: string;
  maxCharsArg?: string;
  inputArg?: string;
  replyArg?: string;
  capturedAtArg?: string;
  sourceArg?: string;
  idempotencyArg?: string;
  timeoutMs: number;
}

function resultText(result: CallToolResult): string {
  if (DENIED_CODES.has(mcpEnvelope(result).code ?? "")) return "";
  const text = mcpResultText(result);
  if (text) return text;
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
}

export function createMcpMemoryProvider(opts: {
  read: McpMemoryOperation;
  write?: McpMemoryOperation;
  attestActor?: boolean;
}): MemoryService {
  const call = async (op: McpMemoryOperation, args: Record<string, unknown>, actorId: string | undefined) => {
    const person = opts.attestActor ? attestedPerson(actorId, "memory provider") : actorId;
    if (person) args[op.actorArg ?? "acting_user"] = person;
    const headers = opts.attestActor && person ? { "x-qm-actor": person } : undefined;
    const result = await withTimeout(() => op.client.callTool(op.tool, args, headers), op.timeoutMs, "memory provider");
    reportEnvelope(mcpEnvelope(result));
    return result;
  };

  const read = async (scopeId: string, query: string, context?: MemoryRecallContext): Promise<string> => {
    const op = opts.read;
    const args: Record<string, unknown> = { [op.queryArg ?? "query"]: query };
    if (op.scopeArg) args[op.scopeArg] = scopeId;
    const maxChars = context?.maxChars;
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars;
    const result = await call(op, args, context?.actorId);
    const { code } = mcpEnvelope(result);
    if (code && code !== "actor_unlinked" && DENIED_CODES.has(code))
      throw new McpCallError(`memory provider refused the read (${code})`, { code });
    const text = resultText(result);
    return maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
  };

  return {
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
      const actor = context?.actorId ?? author;
      if (opts.attestActor && actor === undefined) return 0;
      const args: Record<string, unknown> = { [op.contentArg ?? "content"]: facts.join("\n") };
      if (context?.input && op.inputArg) args[op.inputArg] = context.input;
      if (context?.reply && op.replyArg) args[op.replyArg] = context.reply;
      if (op.capturedAtArg) args[op.capturedAtArg] = at;
      if (op.sourceArg) args[op.sourceArg] = context?.mode ?? "explicit";
      if (context?.idempotencyKey && op.idempotencyArg) args[op.idempotencyArg] = context.idempotencyKey;
      if (op.scopeArg) args[op.scopeArg] = scopeId;
      const { code } = mcpEnvelope(await call(op, args, actor));
      if (code && DENIED_CODES.has(code))
        throw new McpCallError(`memory provider refused the write (${code})`, { code });
      return facts.length;
    },

    async query(scopeId, q, limit = 20, context) {
      const text = await read(scopeId, q, context);
      return text ? text.split("\n").filter(Boolean).slice(0, limit) : [];
    },

    read: (scopeId) => read(scopeId, ""),
  };
}
