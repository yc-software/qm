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
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { createToolKit } from "./agent-tools/kit.ts";
import { endedOnPurpose } from "./agent-tools/record.ts";
import type { SessionMessage } from "../sessions/session-mailbox.ts";
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
  mailShown?: Map<string, { messages: SessionMessage[]; texts: string[] }>;
  resultHold?: ResultHold;
}

type ResultContent = Array<TextContent | ImageContent>;

interface ResultHold {
  holdResult(callId: string, mail: readonly string[]): void;
  settleResult(callId: string, content: ResultContent, withheld: readonly string[]): Promise<unknown> | undefined;
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
  memoryNotebookOnly?: boolean;
  surfaceTools?: boolean;
  delegateWork?: boolean;
  surfaceName?: string;
  surfacePrompt?: SurfaceToolPrompt;
  clientTools?: readonly ClientToolDeclaration[];
}

export type CoreToolOptions = Omit<
  AgentToolsOptions,
  "readOnly" | "memoryNotebookOnly" | "surfaceTools" | "surfaceName" | "surfacePrompt" | "delegateWork" | "clientTools"
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

export function pauseStampAfterToolCall(
  ref: Pick<ToolContextRef, "pausedOnApproval" | "silentRequested" | "runtimeHandoff" | "swarmHeld" | "mailShown"> &
    Partial<Pick<ToolContextRef, "current" | "resultHold">>,
): (info: unknown, signal?: unknown) => Promise<{ terminate?: boolean; content?: ResultContent } | undefined> {
  return async (info) => {
    const call = info as
      { toolCall?: { id?: string }; result?: { terminate?: boolean; content?: ResultContent } } | undefined;
    const callId = call?.toolCall?.id;
    const shown = callId ? ref.mailShown?.get(callId) : undefined;
    const ended = endedOnPurpose(ref);
    if (!shown || !callId) return ended ? { terminate: true } : undefined;
    const content = call?.result?.content ?? [];
    if (!ended && call?.result?.terminate !== true) {
      const persisted = await Promise.resolve(ref.resultHold?.settleResult(callId, content, [])).then(
        () => true,
        () => false,
      );
      if (persisted) await acknowledgeShownMail(ref, callId);
      return undefined;
    }
    ref.mailShown?.delete(callId);
    const kept = content.filter((block) => block.type !== "text" || !shown.texts.includes(block.text));
    await Promise.resolve(ref.resultHold?.settleResult(callId, kept, shown.texts)).catch(() => undefined);
    return { terminate: true, content: kept };
  };
}

export async function acknowledgePersistedMail(
  tools: Pick<ToolContext, "sessionSyscalls"> | undefined,
  history: readonly Item[],
): Promise<void> {
  const persisted = new Set(
    history.flatMap((item) => {
      const ids = item.kind === "ToolResult" ? item.body?.mailIds : undefined;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    }),
  );
  if (!persisted.size || !tools?.sessionSyscalls?.acknowledge) return;
  const unread = (await tools.sessionSyscalls.receive?.()) ?? [];
  const seen = unread.filter((message) => persisted.has(message.id)).map((message) => message.id);
  if (seen.length) await tools.sessionSyscalls.acknowledge(seen);
}

export async function acknowledgeShownMail(
  ref: Pick<ToolContextRef, "mailShown"> & Partial<Pick<ToolContextRef, "current">>,
  callId: string,
): Promise<void> {
  const shown = ref.mailShown?.get(callId);
  if (!shown) return;
  const acknowledged = await Promise.resolve(
    ref.current?.sessionSyscalls?.acknowledge?.(shown.messages.map((message) => message.id)),
  ).then(
    () => true,
    () => false,
  );
  if (acknowledged) ref.mailShown?.delete(callId);
}

const APP_EDIT_TOOL_NAMES = new Set(["app_files", "apps", "execute", "skills", "files", "history"]);

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
    resourceTool("skills", {
      list: discoverSkills(false),
      search: discoverSkills(true),
      read: skill,
      ...(controlTools && ref.current?.selfApi ? { save: saveSkill, edit: editSkill } : {}),
      ...(controlTools ? { share: sharingTool("skill") } : {}),
    }),
    resourceTool("files", {
      read,
      write,
      ...(controlTools ? { share: sharingTool("file") } : {}),
    }),
    resourceTool("apps", {
      publish,
      ...(controlTools ? { share: sharingTool("deploy") } : {}),
    }),
    ...(ref.current?.appFiles ? [resourceTool("app_files", appFileTools(kit))] : []),
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
