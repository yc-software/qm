import { isObj } from "../util/objects.ts";
import type { DocumentInput } from "../core/documents.ts";
import type { TurnHandoff } from "./runtime-types.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Config } from "../config.ts";
import type { ApprovedToolCallSpec, ClientToolDeclaration, ScopeId } from "../types.ts";
import type { Item, NewItem } from "../sessions/items.ts";
import type { ToolContext } from "../tools/primitives.ts";
import { type Phase } from "../../plugins/chassis/src/error-reporting.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { type GoalGovernor, type GoalInbox, type GoalRecord } from "./goal.ts";
import { type ToolResultScreen, type ToolResultScreenInput } from "../security/security-posture.ts";
import { createToolKit } from "./agent-tools/kit.ts";
import { computerTools, validateSandboxTool } from "./agent-tools/computer.ts";
import { turnTools } from "./agent-tools/turn.ts";
import { workspaceTools } from "./agent-tools/workspace.ts";
import { appFileTools } from "./agent-tools/app-files.ts";
import { recallTools } from "./agent-tools/recall.ts";
import { sessionTools } from "./agent-tools/sessions.ts";
import { cronTools } from "./agent-tools/cron.ts";
import { controlPlaneTools } from "./agent-tools/control.ts";
import { surfaceTool } from "./agent-tools/surface.ts";
import { goalTools } from "./agent-tools/goal.ts";
import { pageClientTools } from "./agent-tools/client.ts";
import { mcpTools } from "./agent-tools/mcp.ts";
import { withRetrySafety, withRuntimeBarrier, withToolApprovalGate, withToolSpan } from "./agent-tools/wrappers.ts";
import type { SurfaceToolPrompt } from "../surfaces/registry.ts";

export interface ToolContextRef {
  documents?: DocumentInput[];
  documentsStubbed?: boolean;
  runtimeHandoff?: TurnHandoff;
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
    call?: ApprovedToolCallSpec;
  }>;
  pausedOnApproval?: boolean;
  approvalUnavailable?: string;
  emit?: (item: NewItem) => Promise<Item | undefined>;
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
  steered?: AbortSignal;
  shutdown?: AbortSignal;
  replyOptional?: boolean;
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
  stoppedCalls?: Set<string>;
}

export interface AgentToolsOptions {
  sessionTools?: boolean;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  sandboxCapabilityTtlMs?: number;
  mcpTools?: McpToolDescriptor[];
  controlTools?: boolean;
  sandboxResources?: boolean;
  memorySizedBackends?: string[];
  readOnly?: boolean;
  botActor?: boolean;
  memoryNotebookOnly?: boolean;
  surfaceTools?: boolean;
  delegateWork?: boolean;
  surfaceName?: string;
  surfacePrompt?: SurfaceToolPrompt;
  clientTools?: readonly ClientToolDeclaration[];
}

export type CoreToolOptions = Omit<
  AgentToolsOptions,
  | "readOnly"
  | "botActor"
  | "memoryNotebookOnly"
  | "surfaceTools"
  | "surfaceName"
  | "surfacePrompt"
  | "delegateWork"
  | "clientTools"
>;

export function coreToolOptions(config: Config): CoreToolOptions {
  return {
    sandboxResources: true,
    controlTools: Boolean(config.signingSecret && config.apiBaseUrl),
    execTimeoutMs: config.execTimeoutDefaultMs,
    execTimeoutCeilingMs: config.execTimeoutMaxMs,
    backgroundJobTtlMs: config.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: config.backgroundJobTtlMaxMs,
    sandboxCapabilityTtlMs: config.sandboxCapabilityTtlMs,
  };
}

const READ_ONLY_TOOL_NAMES = new Set(["memory", "history", "finish_silently", "runtime", "sessions", "subagents"]);
const SCHEDULING_TOOL_NAMES = new Set(["cron", "webhook", "goal"]);

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
): (info: unknown, signal?: unknown) => Promise<{ terminate?: boolean } | undefined> {
  return async () => (endedOnPurpose(ref) ? { terminate: true } : undefined);
}

const APP_EDIT_TOOL_NAMES = new Set(["app_files", "apps", "execute", "skills", "files", "history"]);

function withPrivateSharingApproval(tool: ToolDefinition, label: "app" | "file" | "skill" | "schedule") {
  return {
    ...tool,
    needsApproval: (params: unknown) =>
      isObj(params) && params.action === "share" && params.privateRevision !== undefined,
    approvalReason: (params: unknown) => {
      const selected = isObj(params) ? params : {};
      const contents = label === "app" ? "its stored data and history" : "the selected saved content";
      if (label === "schedule")
        return `Publish a new shared schedule from ${String(selected.id)} at private revision ${String(selected.privateRevision)} in ${String(selected.toScope)}. The original is paused; its private conversation and run history remain private. The copy keeps the selected task and schedule, starts only if the original is enabled, and posts future results to a new shared conversation.`;
      return `Share ${label} ${String(selected.id)} at private revision ${String(selected.privateRevision)} with ${String(selected.toScope)} (${selected.permission === "write" ? "manage" : "read"} access). This includes ${contents}; the private conversation and other outputs remain private.${selected.notify === false ? " No notifications or invitations." : ""}`;
    },
  };
}

export function createAgentTools(ref: ToolContextRef, opts?: AgentToolsOptions): ToolDefinition[] {
  const controlTools = !!opts?.controlTools;
  const surfaceTools = !!opts?.surfaceTools;
  const delegateWork = opts?.delegateWork === true;
  const kit = createToolKit(ref, opts);
  const { retryMarks, resourceTool } = kit;
  const { execute, sandboxManagement, background } = computerTools(kit);
  const { discoverSkills, skill, saveSkill, editSkill, read, write, publish } = workspaceTools(kit);
  const { memory, history } = recallTools(kit);
  const { subagentTool, sessionTool, sidebarSessions } = sessionTools(kit);
  const { cron } = cronTools(kit);
  const { webhook, guidance, sharingTool, admin } = controlPlaneTools(kit);
  const { surface } = surfaceTool(kit);
  const { createGoal, getGoal, updateGoal } = goalTools(kit);
  const { clientTools } = pageClientTools(kit);
  const { attach, finishSilently, context, runtime, withdrawApproval } = turnTools(kit);

  const tools = [
    ...(!delegateWork ? [{ ...execute, handlesAbort: true }] : []),
    withPrivateSharingApproval(
      resourceTool("skills", {
        list: discoverSkills(false),
        search: discoverSkills(true),
        read: skill,
        ...(controlTools && ref.current?.selfApi ? { save: saveSkill, edit: editSkill } : {}),
        ...(controlTools ? { share: sharingTool("skill") } : {}),
      }),
      "skill",
    ),
    withPrivateSharingApproval(
      resourceTool("files", {
        read,
        write,
        ...(controlTools ? { share: sharingTool("file") } : {}),
      }),
      "file",
    ),
    withPrivateSharingApproval(
      resourceTool("apps", {
        publish,
        ...(controlTools ? { share: sharingTool("deploy") } : {}),
      }),
      "app",
    ),
    ...(ref.current?.appFiles ? [resourceTool("app_files", appFileTools(kit))] : []),
    memory,
    history,
    ...(!delegateWork ? [background] : []),
    ...(opts?.sessionTools === false ? [] : [subagentTool, ...(sidebarSessions ? [sessionTool] : [])]),
    sandboxManagement,
    ...(controlTools
      ? [
          withPrivateSharingApproval(
            resourceTool("cron", {
              ...Object.fromEntries(
                (cron.parameters.properties.action as { anyOf: Array<{ const: string }> }).anyOf.map(
                  ({ const: action }) => [action, cron],
                ),
              ),
              share: sharingTool("cron"),
            }),
            "schedule",
          ),
          webhook,
          admin,
        ]
      : []),
    ...(controlTools || surfaceTools ? [guidance] : []),
    ...(surfaceTools ? [surface] : [attach]),
    finishSilently,
    withdrawApproval,
    { ...resourceTool("goal", { create: createGoal, get: getGoal, update: updateGoal }), handlesAbort: true },
    runtime,
    context,
    ...clientTools.map((tool) => ({ ...tool, handlesAbort: true })),
  ];
  const { inline, inlineTools, connectorTools } = mcpTools(kit, new Set(tools.map((t) => t.name)));
  tools.push(...inlineTools, ...connectorTools);
  const active = tools.filter(
    (t) =>
      (!ref.current?.appFiles || APP_EDIT_TOOL_NAMES.has(t.name)) &&
      (opts?.readOnly
        ? READ_ONLY_TOOL_NAMES.has(t.name) || inline.has(t.name) || connectorTools.includes(t)
        : !(opts?.memoryNotebookOnly && SCHEDULING_TOOL_NAMES.has(t.name))),
  );
  const clientNames = new Set(clientTools.map((tool) => tool.name));
  return active.map((tool) => {
    const wrapped = withRuntimeBarrier(
      withToolSpan(withToolApprovalGate(validateSandboxTool(tool, kit), kit), ref),
      kit,
    );
    return clientNames.has(tool.name) ? wrapped : withRetrySafety(wrapped, retryMarks);
  });
}
