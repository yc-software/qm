import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "../../../cli/src/canonical-json.ts";
import { redactSensitiveKeys } from "../../../plugins/chassis/src/redact-secrets.ts";
import { toolCallApprovalKey } from "../../core/approval-id.ts";
import { errMessage, reportFailure, swallow } from "../../util/errors.ts";
import { isObj } from "../../util/objects.ts";
import type { ToolRuntime, TurnHalt } from "../turn-tool-state.ts";
import { optionalBoolean, text } from "./shared.ts";

const RETRY_SAFE_FIELD = "retrySafe";

const RETRY_SAFE_SCHEMA = optionalBoolean(
  "true if re-running this call is harmless (read or idempotent); false if it repeats a side effect like sending, charging or creating.",
);
const RERUN_INPUT_MAX_CHARS = 4_000;

export interface RetryMark {
  safe: boolean;
  rerun?: { tool: string; input: Record<string, unknown> };
}

function withRetrySafeField(parameters: unknown): unknown | null {
  if (!isObj(parameters) || parameters.type !== "object" || !isObj(parameters.properties)) return null;
  if (RETRY_SAFE_FIELD in parameters.properties) return null;
  return { ...parameters, properties: { ...parameters.properties, [RETRY_SAFE_FIELD]: RETRY_SAFE_SCHEMA } };
}

function stripRetrySafeField(params: unknown): { params: unknown; retrySafe?: boolean } {
  if (!isObj(params) || !(RETRY_SAFE_FIELD in params)) return { params };
  const { [RETRY_SAFE_FIELD]: retrySafe, ...rest } = params;
  return { params: rest, ...(typeof retrySafe === "boolean" ? { retrySafe } : {}) };
}

export function withRetrySafety(tool: ToolDefinition, marks: Map<string, RetryMark>): ToolDefinition {
  const parameters = withRetrySafeField(tool.parameters);
  if (!parameters) return tool;
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    parameters: parameters as ToolDefinition["parameters"],
    async execute(callId: string, params: unknown, ...rest: unknown[]) {
      const stripped = stripRetrySafeField(params);
      if (stripped.retrySafe !== undefined && isObj(stripped.params)) {
        const replayable = stripped.retrySafe && JSON.stringify(stripped.params).length <= RERUN_INPUT_MAX_CHARS;
        marks.set(callId, {
          safe: stripped.retrySafe,
          ...(replayable ? { rerun: { tool: tool.name, input: stripped.params } } : {}),
        });
      }
      try {
        return await (inner as (...args: unknown[]) => unknown)(callId, stripped.params, ...rest);
      } finally {
        marks.delete(callId);
      }
    },
  } as ToolDefinition;
}

const TOOL_APPROVAL_EXEMPT = new Set(["finish_silently"]);
const RESOURCE_TOOL_NAMES = new Set(["sandbox", "background", "files", "apps", "skills", "goal", "cron", "admin"]);
const DECLARED_TOOL_APPROVAL_REASON = "this tool asks for approval before each call";
const APPROVAL_ARGS_MAX_CHARS = 16_000;

interface ToolApprovalDeclaration {
  needsApproval?: boolean | ((params: unknown) => boolean | Promise<boolean>);
  approvalReason?: string;
}

async function declaredApprovalReason(tool: ToolApprovalDeclaration, params: unknown): Promise<string | undefined> {
  const needed =
    typeof tool.needsApproval === "function" ? await tool.needsApproval(params) : tool.needsApproval === true;
  return needed ? (tool.approvalReason ?? DECLARED_TOOL_APPROVAL_REASON) : undefined;
}

function approvalCallText(label: string, params: unknown): string {
  return `${label} ${canonicalJson(redactSensitiveKeys(params ?? {}))}`;
}

export function withToolApprovalGate(
  tool: ToolDefinition & ToolApprovalDeclaration,
  ref: Pick<ToolRuntime, "approves" | "holdApproval">,
  halt: Pick<TurnHalt, "pauseForApproval">,
  rec: {
    recordCall: (callId: string, payload: Record<string, unknown>) => Promise<void>;
    recordResult: <T extends { content: Array<{ type: string; text?: string }>; details?: unknown }>(
      callId: string,
      summary: Record<string, unknown>,
      ret: T,
      isError?: boolean,
    ) => Promise<T>;
  },
): ToolDefinition {
  if (TOOL_APPROVAL_EXEMPT.has(tool.name)) return tool;
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(callId: string, params: unknown) {
      const resourceTool = RESOURCE_TOOL_NAMES.has(tool.name);
      const resourceAction =
        resourceTool && isObj(params) && typeof params.action === "string" ? params.action : undefined;
      const approvalIdentity = resourceTool ? `${tool.name}:${resourceAction ?? "invalid"}` : tool.name;
      const commandLabel = resourceAction ? `${tool.name} ${resourceAction}` : tool.name;
      let declaredReason: string | undefined;
      try {
        declaredReason = await declaredApprovalReason(tool, params);
      } catch (error) {
        reportFailure("tool approval: needsApproval check", error, tool.name);
        await rec.recordCall(callId, { tool: tool.name, blocked: "approval_check_failed", error: errMessage(error) });
        return rec.recordResult(
          callId,
          { tool: tool.name, blocked: "approval_check_failed" },
          text(`[error] could not check whether this call needs approval: ${errMessage(error)}`),
          true,
        );
      }
      const callKey = declaredReason ? toolCallApprovalKey(approvalIdentity, params) : undefined;
      if (callKey && canonicalJson(params ?? {}).length > APPROVAL_ARGS_MAX_CHARS) {
        const reason = `the arguments are too long to show on an approval card (over ${APPROVAL_ARGS_MAX_CHARS} characters); split the work into smaller calls`;
        await rec.recordCall(callId, { tool: tool.name, blocked: "approval_args_too_long" });
        return rec.recordResult(
          callId,
          { tool: tool.name, blocked: "approval_args_too_long" },
          text(`[blocked] ${reason}`),
          true,
        );
      }
      if (callKey && !ref.approves(callKey)) {
        const reason = declaredReason!;
        halt.pauseForApproval({
          command: approvalCallText(commandLabel, params),
          reason,
          kind: "approval",
          approvalKey: callKey,
          summary: commandLabel,
          grantModes: { session: false, always: false },
          ...(isObj(params) && typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
        });
        await rec.recordCall(callId, {
          tool: tool.name,
          ...(resourceAction ? { action: resourceAction } : {}),
          ...(isObj(params) && typeof params.purpose === "string" ? { purpose: params.purpose } : {}),
          blocked: "needs_approval",
          reason,
        });
        return rec.recordResult(
          callId,
          {
            tool: tool.name,
            ...(resourceAction ? { action: resourceAction } : {}),
            blocked: "needs_approval",
            reason,
          },
          { ...text(`[blocked: needs human approval] ${reason}`), terminate: true },
          true,
        );
      }
      if (!callKey) return (inner as (callId: string, params: unknown) => unknown)(callId, params);
      const release = ref.holdApproval(callId, callKey);
      try {
        return await (inner as (callId: string, params: unknown) => unknown)(callId, params);
      } finally {
        release();
      }
    },
  } as ToolDefinition;
}

export function withToolBodyTiming(tool: ToolDefinition, ref: Pick<ToolRuntime, "reportGapWork">): ToolDefinition {
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(callId: string, params: unknown) {
      const start = Date.now();
      try {
        return await (inner as (callId: string, params: unknown) => unknown)(callId, params);
      } finally {
        try {
          ref.reportGapWork({ phase: "tool_body", tool: tool.name, start, end: Date.now() });
        } catch (error) {
          swallow("tool body timing sink", error);
        }
      }
    },
  } as ToolDefinition;
}

export function withRuntimeBarrier(
  tool: ToolDefinition,
  ref: Pick<
    ToolRuntime,
    "abortSignal" | "runtimeMutationPending" | "beginRuntimeMutation" | "endRuntimeMutation" | "trackRuntimeCall"
  >,
  halt: Pick<TurnHalt, "handoff" | "pausedOnApproval" | "silent">,
): ToolDefinition {
  return {
    ...tool,
    async execute(...args) {
      const [, params] = args;
      if (halt.handoff() || ref.runtimeMutationPending())
        return {
          ...text(
            "Runtime handoff in progress; this call was not executed. Resume unfinished work on the selected runtime.",
          ),
          terminate: !!halt.handoff(),
        };
      const mutation =
        tool.name === "context" || (tool.name === "runtime" && (!isObj(params) || params.action !== "get"));
      if (mutation) {
        const settled = ref.beginRuntimeMutation();
        try {
          await settled;
          if (ref.abortSignal?.aborted || halt.pausedOnApproval() || halt.silent())
            return { ...text("Runtime change cancelled before execution."), terminate: true };
          return await tool.execute(...args);
        } finally {
          ref.endRuntimeMutation();
        }
      }
      return ref.trackRuntimeCall(Promise.resolve().then(() => tool.execute(...args)));
    },
  };
}
