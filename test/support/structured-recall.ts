import type { McpClient } from "../../src/mcp/mcp-client.ts";

export type StructuredFact = Record<string, unknown>;

export const structuredRecall = (answer: () => StructuredFact[] | Error, code?: string): McpClient => ({
  async listTools() {
    return { tools: [] };
  },
  async callTool() {
    const facts = answer();
    if (facts instanceof Error) throw facts;
    return {
      content: [
        {
          type: "text",
          text: facts.map((fact) => `- ${String(fact.text)} (${String(fact.date)}; ${String(fact.kind)})`).join("\n"),
        },
      ],
      structuredContent: { facts, truncated: false, ...(code ? { code } : {}) },
    };
  },
});
