import { readFileSync } from "node:fs";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

interface ContractTool {
  name: string;
  description: string;
  mutating: boolean;
  input_schema: Tool["inputSchema"] & { properties: Record<string, unknown> };
}

export const contract = JSON.parse(
  readFileSync(new URL("../fixtures/gbrain/qm-memory-provider-v3.json", import.meta.url), "utf8"),
) as {
  tools: ContractTool[];
  personal_tools: { tools: ContractTool[] };
  actor: { header: string; argument: string; actor_id: { pattern: string } };
  memory_recall: { limits: { max_chars: { min: number; max: number } } };
  unlinked_recall: CallToolResult;
  memory_write: {
    limits: { facts: { min: number; max: number }; provenance_chars: number; idempotency_key: { pattern: string } };
    committed: { content: string };
    pending: { content: string };
  };
  errors: { codes: Array<{ code: string; class: string; summary: string; reasons?: Array<{ reason: string }> }> };
};

export const contractTools = [...contract.tools, ...contract.personal_tools.tools];
