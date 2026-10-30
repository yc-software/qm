import type { DocumentInput } from "../core/documents.ts";
import type { TurnHandoff } from "./runtime-types.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Config } from "../config.ts";
import type { ClientToolDeclaration, EntryType, ScopeId } from "../types.ts";
import type { ToolContext } from "../tools/primitives.ts";
import { type Phase } from "../../plugins/chassis/src/error-reporting.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { isObj } from "../util/objects.ts";
import { type GoalGovernor, type GoalInbox, type GoalRecord } from "./goal.ts";
import { type ToolResultScreen, type ToolResultScreenInput } from "../security/security-posture.ts";
import { createToolKit } from "./agent-tools/kit.ts";
import { computerTools, validateSandboxTool } from "./agent-tools/computer.ts";
import { turnTools } from "./agent-tools/turn.ts";
import { workspaceTools } from "./agent-tools/workspace.ts";
import { recallTools } from "./agent-tools/recall.ts";
import { sessionTools } from "./agent-tools/sessions.ts";
import { cronTools } from "./agent-tools/cron.ts";
import { controlPlaneTools } from "./agent-tools/control.ts";
import { surfaceTool } from "./agent-tools/surface.ts";
import { goalTools } from "./agent-tools/goal.ts";
import { pageClientTools } from "./agent-tools/client.ts";
import { mcpTools } from "./agent-tools/mcp.ts";
import { withRetrySafety, withRuntimeBarrier, withToolApprovalGate, withToolSpan } from "./agent-tools/wrappers.ts";

export interface ToolContextRef {
  documents?: DocumentInput[];
  documentsStubbed?: boolean;
  runtimeHandoff?: TurnHandoff;
  runtimeRunId?: string;
  runtimeActorId?: string;
  runtimeMutationPending?: boolean;
  runtimeInFlight?: Set<Promise<unknown>>;
  current: ToolContext | null;
  pendingApprovals?: Array<{
    command: string;
    reason: string;
    kind?: "approval";
    matched?: string;
    purpose?: string;
    approvalKey?: string;
    summary?: string;
    grantModes?: { session: boolean; always: boolean };
  }>;
  pausedOnApproval?: boolean;
  emit?: (entry: { type: EntryType; payload: unknown; scopeLabel: ScopeId }) => void | Promise<unknown>;
  scopeLabel?: ScopeId;
  orgScopeId?: ScopeId;
  llmCapture?: Array<{
    envelope: unknown;
    truncated: boolean;
    transport?: { modelId?: string; headers?: Record<string, string> };
  }>;
  modelCalls?: number;
  stepPhase?: Phase;
  firstTokenPhase?: Phase;
  onModelRequest?: () => void;
  fast?: boolean;
  abortSignal?: AbortSignal;
  shutdown?: AbortSignal;
  pollFire?: boolean;
  silentRequested?: boolean;
  swarmHeld?: boolean;

  goal?: GoalRecord | null;
  saveGoal?: (goal: GoalRecord) => Promise<void>;
  goalOpenedThisTurn?: boolean;

  goalRound?: number;

  goalMeter?: import("./goal.ts").GrindMeter;
  goalInbox?: GoalInbox;
  modelHasPrices?: () => boolean;
  governGoal?: GoalGovernor;
  goalRecentWork?: () => string;
  screenToolResult?: (input: ToolResultScreenInput) => Promise<ToolResultScreen>;
  toolApprovalGate?: (tool: string, callKey?: string) => boolean;
  approvedToolCalls?: Map<string, string>;
}

export interface AgentToolsOptions {
  sessionTools?: boolean;
  reachExec?: boolean;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  sandboxCapabilityTtlMs?: number;
  mcpTools?: McpToolDescriptor[];
  controlTools?: boolean;
  sandboxResources?: boolean;
  readOnly?: boolean;
  surfaceTools?: boolean;
  delegateWork?: boolean;
  surfaceName?: string;
  clientTools?: readonly ClientToolDeclaration[];
}

export type CoreToolOptions = Omit<
  AgentToolsOptions,
  "readOnly" | "surfaceTools" | "surfaceName" | "delegateWork" | "clientTools"
>;

export function coreToolOptions(config: Config): CoreToolOptions {
  return {
    sandboxResources: true,
    reachExec: config.reachExecEnabled,
    controlTools: Boolean(config.signingSecret && config.apiBaseUrl),
    execTimeoutMs: config.execTimeoutDefaultMs,
    execTimeoutCeilingMs: config.execTimeoutMaxMs,
    backgroundJobTtlMs: config.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: config.backgroundJobTtlMaxMs,
    sandboxCapabilityTtlMs: config.sandboxCapabilityTtlMs,
  };
}

const READ_ONLY_TOOL_NAMES = new Set(["memory", "history", "finish_silently", "runtime", "sessions", "subagents"]);

export function endedOnPurpose(ref: {
  runtimeHandoff?: unknown;
  silentRequested?: boolean;
  pausedOnApproval?: boolean;
  swarmHeld?: boolean;
}): boolean {
  return !!(ref.runtimeHandoff || ref.silentRequested || ref.pausedOnApproval || ref.swarmHeld);
}

export function pauseStampAfterToolCall(
  ref: Pick<ToolContextRef, "pausedOnApproval" | "silentRequested" | "runtimeHandoff" | "swarmHeld">,
  prior?: (
    info: unknown,
    signal?: unknown,
  ) => Promise<{ terminate?: boolean } | undefined> | { terminate?: boolean } | undefined,
): (info: unknown, signal?: unknown) => Promise<{ terminate?: boolean } | undefined> {
  return async (info, signal) => {
    const upstream = prior ? await prior(info, signal) : undefined;
    if (endedOnPurpose(ref)) return { ...upstream, terminate: true };
    return upstream;
  };
}

export function createAgentTools(ref: ToolContextRef, opts?: AgentToolsOptions): ToolDefinition[] {
  const controlTools = !!opts?.controlTools;
  const surfaceTools = !!opts?.surfaceTools;
  const delegateWork = opts?.delegateWork === true;
  const kit = createToolKit(ref, opts);
  const { retryMarks, resourceTool } = kit;
  const { execute, sandboxManagement, background } = computerTools(kit);
  const { discoverSkills, skill, read, installCanvas, write, publish } = workspaceTools(kit);
  const { memory, history } = recallTools(kit);
  const { subagentTool, sessionTool, sidebarSessions } = sessionTools(kit);
  const { cron } = cronTools(kit);
  const { webhook, guidance, sharingTool, admin } = controlPlaneTools(kit);
  const { surface } = surfaceTool(kit);
  const { createGoal, getGoal, updateGoal } = goalTools(kit);
  const { clientTools } = pageClientTools(kit);
  const { attach, finishSilently, context, runtime } = turnTools(kit);

  const tools = [
    ...(!delegateWork ? [execute] : []),
    resourceTool("skills", {
      list: discoverSkills(false),
      search: discoverSkills(true),
      read: skill,
      ...(controlTools ? { share: sharingTool("skill"), move: sharingTool("skill", true) } : {}),
    }),
    {
      ...resourceTool("files", {
        read,
        write,
        ...(controlTools ? { share: sharingTool("file") } : {}),
        ...(ref.current?.installSharedCanvas ? { install_canvas: installCanvas } : {}),
      }),
      needsApproval: (params: unknown) => isObj(params) && params.action === "install_canvas",
      approvalReason: "install an always-on canvas someone shared with you; its code runs in your QM web UI",
    },
    resourceTool("apps", {
      publish,
      ...(controlTools ? { share: sharingTool("deploy"), move: sharingTool("deploy", true) } : {}),
    }),
    memory,
    history,
    ...(!delegateWork ? [background] : []),
    ...(opts?.sessionTools === false ? [] : [subagentTool, ...(sidebarSessions ? [sessionTool] : [])]),
    sandboxManagement,
    ...(controlTools
      ? [
          resourceTool("cron", {
            ...Object.fromEntries(
              (cron.parameters.properties.action as { anyOf: Array<{ const: string }> }).anyOf.map(
                ({ const: action }) => [action, cron],
              ),
            ),
            share: sharingTool("cron"),
          }),
          webhook,
          admin,
        ]
      : []),
    ...(controlTools || surfaceTools ? [guidance] : []),
    ...(surfaceTools ? [surface] : [attach]),
    finishSilently,
    resourceTool("goal", { create: createGoal, get: getGoal, update: updateGoal }),
    runtime,
    context,
    ...clientTools,
  ];
  const { inline, inlineTools, connectorTools } = mcpTools(kit, new Set(tools.map((t) => t.name)));
  tools.push(...inlineTools, ...connectorTools);
  const active = opts?.readOnly
    ? tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name) || inline.has(t.name) || connectorTools.includes(t))
    : tools;
  const clientNames = new Set(clientTools.map((tool) => tool.name));
  return active.map((tool) => {
    const wrapped = withRuntimeBarrier(
      withToolSpan(withToolApprovalGate(validateSandboxTool(tool, kit), kit), ref),
      ref,
    );
    return clientNames.has(tool.name) ? wrapped : withRetrySafety(wrapped, retryMarks);
  });
}
