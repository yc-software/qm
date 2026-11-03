import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpCallError, mcpEnvelope, mcpResultText, type McpClient } from "../mcp/mcp-client.ts";
import { withTimeout } from "../util/async.ts";
import { attestedPerson } from "../directory/person.ts";
import type { MemoryRecallContext, MemoryService } from "./memory-service.ts";
import type { MemoryCandidate } from "./facts.ts";
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
  const text = mcpResultText(result);
  if (text) return text;
  return result.structuredContent == null ? "" : JSON.stringify(result.structuredContent);
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
  });
  return facts as ProviderFact[];
}

const stamped = (fact: ProviderFact) => {
  const stamp = [fact.date, fact.kind].filter((part) => typeof part === "string" && part).join("; ");
  return stamp ? `(${stamp}) ${fact.text}` : fact.text;
};

export function createMcpMemoryProvider(opts: {
  read: McpMemoryOperation;
  write?: McpMemoryOperation;
  attestActor?: boolean;
}): MemoryService {
  const call = async (op: McpMemoryOperation, args: Record<string, unknown>, actorId: string | undefined) => {
    const person = opts.attestActor ? attestedPerson(actorId, "memory provider") : actorId;
    if (person) args[op.actorArg ?? "acting_user"] = person;
    const headers = opts.attestActor && person ? { "x-qm-actor": person } : undefined;
    const deadline = new AbortController();
    const result = await withTimeout(
      () => op.client.callTool(op.tool, args, headers, deadline.signal),
      op.timeoutMs,
      "memory provider",
    ).finally(() => deadline.abort());
    reportEnvelope(mcpEnvelope(result));
    return result;
  };

  const read = async (scopeId: string, query: string, context?: MemoryRecallContext): Promise<CallToolResult> => {
    const op = opts.read;
    const args: Record<string, unknown> = { [op.queryArg ?? "query"]: query };
    if (op.scopeArg) args[op.scopeArg] = scopeId;
    const maxChars = context?.maxChars;
    if (maxChars && op.maxCharsArg) args[op.maxCharsArg] = maxChars;
    const result = await call(op, args, context?.actorId);
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
      room -= text.length + 1;
      if (room < 0 && fitting.length) break;
      fitting.push({ ref: fact.id, claim: fact.text, text });
    }
    return fitting;
  };

  return {
    async recall(scopeId, context) {
      const result = await read(scopeId, context?.query ?? "", context);
      return rows(result, context?.maxChars, "- ");
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
      const result = await read(scopeId, q, context);
      return rows(result, context?.maxChars, "").slice(0, limit);
    },

    read: async (scopeId) => resultText(await read(scopeId, "")),
  };
}
