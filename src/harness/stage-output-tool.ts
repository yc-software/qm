import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import type { SessionEntry, StageOutputDeclaration } from "../types.ts";
import { isObj } from "../util/objects.ts";

export const STAGE_OUTPUT_TOOL = "submit_stage_output";

type ToolText = { content: Array<{ type: "text"; text: string }>; details: Record<string, never> };

export function stageOutputTool(
  declaration: StageOutputDeclaration,
  record: {
    call(callId: string, payload: Record<string, unknown>): Promise<void>;
    result(callId: string, summary: Record<string, unknown>, ret: ToolText, isError?: boolean): Promise<ToolText>;
  },
): ToolDefinition {
  const text = (s: string): ToolText => ({ content: [{ type: "text", text: s }], details: {} });
  return defineTool({
    name: STAGE_OUTPUT_TOOL,
    label: STAGE_OUTPUT_TOOL,
    description: declaration.description,
    parameters: declaration.schema as never,
    async execute(callId, params: unknown) {
      await record.call(callId, { ...(isObj(params) ? params : {}), tool: STAGE_OUTPUT_TOOL });
      const accept = declaration.accept ?? declaration.schema;
      if (!isObj(params) || !Check(accept, params)) {
        const problems = Errors(accept, params)
          .slice(0, 5)
          .map((error) => `${error.instancePath || "/"} ${error.message}`);
        return record.result(
          callId,
          { tool: STAGE_OUTPUT_TOOL, invalid: true },
          text(`[error] invalid ${STAGE_OUTPUT_TOOL} arguments: ${problems.join("; ")}. Fix them and submit again.`),
          true,
        );
      }
      return record.result(callId, { tool: STAGE_OUTPUT_TOOL, submitted: true, output: params }, text("[submitted]"));
    },
  }) as unknown as ToolDefinition;
}

export function submittedStageOutput(
  entries: readonly SessionEntry[],
  userSeq: number,
): Record<string, unknown> | undefined {
  const next = entries.find(
    (entry) => entry.seq > userSeq && entry.type === "user" && !(isObj(entry.payload) && entry.payload.steered),
  );
  const output = entries.findLast(
    (entry) =>
      entry.seq > userSeq &&
      (next === undefined || entry.seq < next.seq) &&
      entry.type === "tool_result" &&
      isObj(entry.payload) &&
      entry.payload.tool === STAGE_OUTPUT_TOOL &&
      entry.payload.submitted === true,
  )?.payload;
  return isObj(output) && isObj(output.output) ? output.output : undefined;
}
