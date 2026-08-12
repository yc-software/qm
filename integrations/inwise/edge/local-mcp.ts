import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ReadOnlyTool } from "../common/protocol.js";

export async function callLocalMcp(
  mcpUrl: string,
  tool: ReadOnlyTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = new Client({ name: "inwise-qm-edge", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    const result = await client.callTool({ name: tool, arguments: args });
    if (result.isError) {
      const message =
        extractText(result.content) ?? `Inwise tool ${tool} failed`;
      throw new Error(message);
    }
    const text = extractText(result.content);
    if (text === undefined) return result;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function extractText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0] as { type?: unknown; text?: unknown };
  return item.type === "text" && typeof item.text === "string"
    ? item.text
    : undefined;
}
