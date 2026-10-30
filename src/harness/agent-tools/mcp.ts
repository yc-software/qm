import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { deferredMcpTools, mcpToolDescription, searchMcpTools, visibleMcpTools } from "../deferred-tools.ts";
import { errMessage } from "../../util/errors.ts";
import { isObj } from "../../util/objects.ts";
import { text, type ToolKit } from "./kit.ts";
import { withToolApprovalGate } from "./wrappers.ts";

export function mcpTools(kit: ToolKit, nativeNames: Set<string>) {
  const { ref, opts, recordCall, recordResult, recordExternalResult } = kit;
  const mcpDefs = visibleMcpTools(opts?.mcpTools, opts?.readOnly);
  const mcpCandidates = mcpDefs.map((d) => ({
    ...defineTool({
      name: d.name,
      label: d.name,
      description: mcpToolDescription(d),
      parameters: (d.inputSchema ?? { type: "object", properties: {} }) as never,
      async execute(callId, params) {
        const tc = ref.current;
        if (!tc) return text("[error] no active tool context");
        await recordCall(callId, { tool: d.name, mcpServer: d.serverId, args: params });
        try {
          const out = await tc.callMcpTool(
            d.name,
            (params ?? {}) as Record<string, unknown>,
            ref.approvedToolCalls?.get(callId),
          );
          return recordExternalResult(
            callId,
            { tool: d.name, mcpServer: d.serverId },
            text(out || "[empty result]"),
            `mcp server ${d.serverId}`,
          );
        } catch (error) {
          return recordResult(
            callId,
            { tool: d.name, mcpServer: d.serverId, failed: true },
            text(`[error] ${errMessage(error)}`),
            true,
          );
        }
      },
    }),
    needsApproval: d.catalog
      ? async (params: unknown) => {
          const tc = ref.current;
          if (!tc) return true;
          return tc.mcpToolNeedsApproval(d.name, (isObj(params) ? params : {}) as Record<string, unknown>);
        }
      : d.needsApproval === true,
  }));
  const toolSearch = defineTool({
    name: "tool_search",
    label: "tool_search",
    description:
      "Find connector tools by keyword. Returns each match's name, description and input schema; an empty query or * lists every tool.",
    parameters: Type.Object({
      query: Type.String({ description: "Words to match against tool names and descriptions." }),
    }),
    async execute(callId, params) {
      await recordCall(callId, { tool: "tool_search", query: params.query });
      return recordResult(callId, { tool: "tool_search" }, text(searchMcpTools(searchable, params.query)));
    },
  });
  const mcpCall = defineTool({
    name: "mcp_call",
    label: "mcp_call",
    description: "Run a connector tool listed under ## Connectors or found with tool_search.",
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "Server id, as shown in brackets or by tool_search." })),
      tool: Type.String({ description: "Tool name on that server." }),
      args: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Arguments matching that tool's input schema." }),
      ),
    }),
    async execute(callId, params, ...rest) {
      const target =
        params.server === undefined
          ? callableTools.get(params.tool)
          : toolsByServer.get(params.server)?.get(params.tool);
      if (target) return target.execute(callId, params.args ?? {}, ...rest);
      const named = params.server === undefined ? `"${params.tool}"` : `"${params.tool}" on server "${params.server}"`;
      await recordCall(callId, {
        tool: "mcp_call",
        server: params.server,
        target: params.tool,
        args: params.args,
      });
      return recordResult(
        callId,
        { tool: "mcp_call", failed: true },
        text(`[error] unknown tool ${named}; use tool_search to find connector tools.`),
        true,
      );
    },
  });

  const searchable = deferredMcpTools(opts?.mcpTools, opts?.readOnly);
  const deferredNames = new Set(searchable.map((d) => d.name));
  const inlineTools = mcpCandidates.filter((t) => {
    if (deferredNames.has(t.name)) return false;
    if (!nativeNames.has(t.name)) return true;
    console.warn(`[mcp] ${t.name} is hidden because a built-in tool has the same name`);
    return false;
  });
  const inline = new Set(inlineTools.map((t) => t.name));
  const callableTools = new Map(
    mcpCandidates
      .filter((t) => deferredNames.has(t.name) || inline.has(t.name))
      .map((t) => [t.name, withToolApprovalGate(t, kit)]),
  );
  const toolsByServer = new Map<string, Map<string, ToolDefinition>>();
  for (const d of searchable)
    toolsByServer.set(
      d.serverId,
      (toolsByServer.get(d.serverId) ?? new Map()).set(d.remoteName, callableTools.get(d.name)!),
    );
  const connectorTools: ToolDefinition[] = searchable.length ? [toolSearch, mcpCall] : [];
  return { inline, inlineTools, connectorTools };
}
