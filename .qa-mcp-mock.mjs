import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
const log = (o) =>
  appendFileSync("/tmp/qa/mcp-mock.log", JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
function build() {
  const s = new McpServer({ name: "qa-records", version: "1.0.0" });
  s.registerTool(
    "lookup_record",
    { description: "Look up a record by id", inputSchema: { id: z.number() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      log({ tool: "lookup_record", id });
      return { content: [{ type: "text", text: `record ${id}: Example Widget` }] };
    },
  );
  s.registerTool(
    "delete_record",
    {
      description: "Permanently delete a record by id",
      inputSchema: { id: z.number() },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({ id }) => {
      log({ tool: "delete_record", id });
      return { content: [{ type: "text", text: `deleted record ${id}` }] };
    },
  );
  return s;
}
createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}).listen(9411, "127.0.0.1", () => console.log("mcp mock on 9411"));
