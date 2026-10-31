import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpEnvelope, mcpResultText, type McpClient } from "../mcp/mcp-client.ts";
import { withTimeout } from "../util/async.ts";
import { attestableActor, canonicalPerson, UNATTESTABLE_ACTOR_FIX, UnattestableActor } from "../directory/person.ts";
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
  if (text || mcpEnvelope(result).code) return text;
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
}

export function createMcpMemoryProvider(opts: {
  read: McpMemoryOperation;
  write?: McpMemoryOperation;
  attestActor?: boolean;
}): MemoryService {
  const call = async (op: McpMemoryOperation, args: Record<string, unknown>, actorId: string | undefined) => {
    const person = opts.attestActor ? attestableActor(actorId && canonicalPerson(actorId)) : actorId;
    if (opts.attestActor && !person)
      throw new UnattestableActor(`memory provider can't attest this actor. ${UNATTESTABLE_ACTOR_FIX}`);
    if (person) args[op.actorArg ?? "acting_user"] = person;
    const headers = opts.attestActor && person ? { "x-qm-actor": person } : undefined;
    return withTimeout(() => op.client.callTool(op.tool, args, headers), op.timeoutMs, "memory provider");
  };

  const read = async (
    scopeId: string,
    query: string,
    context?: {
      actorId?: string;
      maxChars?: number;
      envelope?: (envelope: { code?: string; status?: string }) => void;
    },
  ): Promise<string> => {
    const op = opts.read;
    const args: Record<string, unknown> = { [op.queryArg ?? "query"]: query };
    if (op.scopeArg) args[op.scopeArg] = scopeId;
    const maxChars = context?.maxChars;
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars;
    const result = await call(op, args, context?.actorId);
    context?.envelope?.(mcpEnvelope(result));
    const text = resultText(result);
    return maxChars && text.length > maxChars ? text.slice(0, maxChars) : text;
  };

  return {
    async recall(scopeId, context) {
      const text = (await read(scopeId, context?.query ?? "", context)).trim();
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
      if (op.scopeArg) args[op.scopeArg] = scopeId;
      const result = await call(op, args, context?.actorId ?? author);
      context?.envelope?.(mcpEnvelope(result));
      return facts.length;
    },

    async query(scopeId, q, limit = 20, context) {
      const text = await read(scopeId, q, context);
      return text ? text.split("\n").filter(Boolean).slice(0, limit) : [];
    },

    read: (scopeId) => read(scopeId, ""),
  };
}
