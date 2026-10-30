import { MAX_OUTBOUND_FILES } from "../../core/attachments.ts";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { NeedsApproval } from "../../tools/primitives.ts";
import { isObj } from "../../util/objects.ts";
import type { ToolContextRef, AgentToolsOptions } from "../agent-tools.ts";

import { createRecorder } from "./record.ts";

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

export const outsideWorkspace = (path: string): string =>
  `[not in the computer's workspace: ${path}; only workspace files can be read, so copy it there or name it relative to the workspace]`;

export const outboundFilesSchema = Type.Array(
  Type.Union([
    Type.String({ minLength: 1 }),
    Type.Object({ file_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  ]),
  { maxItems: MAX_OUTBOUND_FILES, description: 'Workspace paths or {file_id: "stored Files ID"} objects.' },
);
export const outboundSandboxSchema = Type.Optional(
  Type.String({
    minLength: 1,
    description: "Sandbox for workspace paths.",
  }),
);
export const sandboxSelector = (description: string) => Type.Optional(Type.String({ minLength: 1, description }));

export function createToolKit(ref: ToolContextRef, opts?: AgentToolsOptions) {
  const recorder = createRecorder(ref);
  const { recordResult } = recorder;
  const blockOnApproval = (
    callId: string,
    e: NeedsApproval,
    purpose?: string,
    summary: Record<string, unknown> = { tool: "execute" },
  ) => {
    ref.pendingApprovals?.push({
      command: e.command,
      reason: e.approvalReason,
      kind: e.kind,
      matched: e.matched,
      ...(purpose ? { purpose } : {}),
      ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
      ...(e.grantModes ? { grantModes: e.grantModes } : {}),
    });
    ref.pausedOnApproval = true;
    return recordResult(
      callId,
      { ...summary, blocked: "needs_approval", reason: e.approvalReason },
      { ...text(`[blocked: needs human approval] ${e.approvalReason}`), terminate: true },
      true,
    );
  };
  const unavailable = (callId: string, tool: string) =>
    recordResult(
      callId,
      { tool, error: "control_unavailable" },
      text(
        `[error] control-plane tools (crons, webhooks, standing instructions, sharing) aren't available on this turn.`,
      ),
      true,
    );
  const isUnavailable = (r: unknown): r is { ok: false; code: "control_unavailable" } =>
    isObj(r) && r.code === "control_unavailable";
  function requiredSuffix(operation: ToolDefinition): string {
    const required = ((operation.parameters as { required?: string[] }).required ?? []).filter(
      (key) => key !== "action",
    );
    return required.length ? ` Requires ${required.join(", ")}.` : "";
  }
  function resourceTool(name: string, actions: Record<string, ToolDefinition>): ToolDefinition {
    const groups = [...new Set(Object.values(actions))].map((operation) => ({
      operation,
      actions: Object.keys(actions).filter((action) => actions[action] === operation),
    }));
    const variants = groups.map((group) => ({
      ...group.operation.parameters,
      ...Type.Object(
        {
          ...(group.operation.parameters as { properties: Record<string, TSchema> }).properties,
          action: Type.Union(group.actions.map((action) => Type.Literal(action))),
        },
        { additionalProperties: false },
      ),
    }));
    const properties: Record<string, TSchema> = {};
    for (const variant of variants) {
      for (const [key, schema] of Object.entries(variant.properties)) properties[key] = Type.Optional(schema);
    }
    properties.action = Type.Union(Object.keys(actions).map((action) => Type.Literal(action)));
    return defineTool({
      name,
      label: name,
      description: groups
        .map(({ actions, operation }) => `${actions.join("/")}: ${operation.description}${requiredSuffix(operation)}`)
        .join("\n\n"),
      parameters: Type.Object(properties, { additionalProperties: true }),
      async execute(callId, params, signal, onUpdate, ctx) {
        const index = groups.findIndex((group) => group.actions.includes(String(params.action)));
        if (index < 0 || !Check(variants[index]!, params)) {
          return recordResult(
            callId,
            { tool: name, action: params.action, error: "invalid_arguments" },
            text(
              `[error] Invalid arguments for ${name} action ${String(params.action)}. ${groups[index]?.operation.description ?? ""}`,
            ),
            true,
          );
        }
        return actions[String(params.action)]!.execute(callId, params, signal, onUpdate, ctx);
      },
    });
  }
  return {
    ref,
    opts,
    ...recorder,
    blockOnApproval,
    unavailable,
    isUnavailable,
    resourceTool,
  };
}

export type ToolKit = ReturnType<typeof createToolKit>;
