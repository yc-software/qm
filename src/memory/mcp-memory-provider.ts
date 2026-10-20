import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpResultText, type McpClient } from "../mcp/mcp-client.ts";
import { withTimeout } from "../util/async.ts";
import type { MemoryService } from "./memory-service.ts";

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
  const text = mcpResultText(result);
  if (text) return text;
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
}

export function createMcpMemoryProvider(opts: { read: McpMemoryOperation; write?: McpMemoryOperation }): MemoryService {
  const read = async (scopeId: string, query: string, actorId?: string, maxChars?: number): Promise<string> => {
    const op = opts.read;
    const args: Record<string, unknown> = { [op.queryArg ?? "query"]: query };
    if (actorId) args[op.actorArg ?? "acting_user"] = actorId;
    if (op.scopeArg) args[op.scopeArg] = scopeId;
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars;
    const text = resultText(
      await withTimeout(() => op.client.callTool(op.tool, args), op.timeoutMs, "memory provider"),
    );
    return maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
  };

  return {
    async recall(scopeId, context) {
      const text = (await read(scopeId, context?.query ?? "", context?.actorId, context?.maxChars)).trim();
      return text ? [{ text, score: 0.2 }] : [];
    },

    async capture(scopeId, facts, at, author, context) {
      const op = opts.write;
      if (!op) throw new Error("memory provider write is not configured");
      const args: Record<string, unknown> = { [op.contentArg ?? "content"]: facts.join("\n") };
      if (context?.input && op.inputArg) args[op.inputArg] = context.input;
      if (context?.reply && op.replyArg) args[op.replyArg] = context.reply;
      if (op.capturedAtArg) args[op.capturedAtArg] = at;
      if (op.sourceArg) args[op.sourceArg] = context?.mode ?? "explicit";
      if (context?.idempotencyKey && op.idempotencyArg) args[op.idempotencyArg] = context.idempotencyKey;
      const actorId = context?.actorId ?? author;
      if (actorId) args[op.actorArg ?? "acting_user"] = actorId;
      if (op.scopeArg) args[op.scopeArg] = scopeId;
      await withTimeout(() => op.client.callTool(op.tool, args), op.timeoutMs, "memory provider");
      return facts.length;
    },

    async query(scopeId, q, limit = 20, context) {
      const text = await read(scopeId, q, context?.actorId, context?.maxChars);
      return text ? text.split("\n").filter(Boolean).slice(0, limit) : [];
    },

    read: (scopeId) => read(scopeId, ""),
  };
}
