import type { ReplayImageRef } from "./replay.ts";
import type { StepFields } from "./pi-step-recorder.ts";
import { randomBytes } from "node:crypto";
import {
  parseSecurityScreenVerdict,
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
} from "../security/security-posture.ts";
import type { ScopeId } from "../types.ts";
import { storedItem, type Item } from "../sessions/items.ts";
import { createAgentTools, type AgentToolsOptions, type ToolContextRef } from "./agent-tools.ts";
import { goalWorkFromItems } from "./goal.ts";
import type { HarnessLlmRequestRecord, HarnessModelUtilities, HarnessTurnInput, HarnessTurnResult } from "./harness.ts";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { INTERRUPTED_TOOL_RESULT } from "./context-compaction.ts";

export interface HarnessToolPlumbing {
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  controlTools?: boolean;
  sandboxResources?: boolean;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  sandboxCapabilityTtlMs?: number;
}

export type BridgedTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    callId: string,
    args: unknown,
  ): Promise<{
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    terminate?: boolean;
  }>;
};

export interface SteerIntake {
  text: string;
  prompt?: string;
  ts?: string;
  attachments?: HarnessTurnInput["attachments"];
  images?: HarnessTurnInput["images"];
  author?: string;
  acknowledge?: () => Promise<void>;
}

export function imageRefs(images: HarnessTurnInput["images"]): { images?: ReplayImageRef[] } {
  if (!images?.length) return {};
  return {
    images: images.map((image) => ({
      mimeType: image.mimeType,
      ...(image.artifactId ? { artifactId: image.artifactId } : {}),
    })),
  };
}

export async function recordSteerIntake(turn: HarnessTurnInput, steer: SteerIntake): Promise<void> {
  await turn.emit({
    kind: "SteeringMessage",
    text: steer.text,
    author: steer.author ?? null,
    body: {
      ...(steer.ts ? { ts: steer.ts } : {}),
      ...(steer.prompt !== undefined && steer.prompt !== steer.text ? { prompt: steer.prompt } : {}),
      ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
      ...imageRefs(steer.images),
    },
  });
  await steer.acknowledge?.().catch(swallowAs("steer acknowledge", undefined));
}

const STOPPED_FALLBACK_REASON = "unexpectedly";

export async function recordStoppedTurn(
  turn: HarnessTurnInput,
  partial: string,
  reason: string = STOPPED_FALLBACK_REASON,
  replay: StepFields | null = null,
): Promise<Item | null> {
  if (turn.shutdown?.aborted) return null;
  const answer = partial.trim()
    ? await turn.emit({
        kind: "AgentMessage",
        text: partial,
        step: replay?.step ?? null,
        body: { stopped: true, ...replay?.body },
      })
    : null;
  const note = await turn.emit({ kind: "Stop", body: { reason } });
  return note ?? answer;
}

export function harnessToolContext(turn: HarnessTurnInput): ToolContextRef {
  return {
    current: turn.tools,
    runtimeActorId: turn.runtimeActorId,
    pendingApprovals: [],
    pausedOnApproval: false,
    silentRequested: false,
    pollFire: Boolean(turn.pollFire),
    goal: turn.goal ?? null,
    ...(turn.goalMeter ? { goalMeter: turn.goalMeter } : {}),
    ...(turn.goalContinuation || turn.continueTurn ? { goalRound: 1 } : {}),
    saveGoal: turn.saveGoal,
    ...(turn.goalInbox ? { goalInbox: turn.goalInbox } : {}),
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenToolResult: turn.screenToolResult,
    governGoal: turn.governGoal,
    goalRecentWork: () => goalWorkFromItems(turn.history.slice(-40)),
    toolApprovalGate: turn.toolApprovalGate,
    shutdown: turn.shutdown,
  };
}

export function harnessToolOptions(opts: HarnessToolPlumbing, turn?: HarnessTurnInput): AgentToolsOptions {
  return {
    scratchExec: opts.scratchExec,
    ownerAuthExec: opts.ownerAuthExec,
    reachExec: opts.reachExec,
    ...(turn?.mcpTools?.length ? { mcpTools: turn.mcpTools } : {}),
    controlTools: opts.controlTools,
    sandboxResources: opts.sandboxResources,
    execTimeoutMs: opts.execTimeoutMs,
    execTimeoutCeilingMs: opts.execTimeoutCeilingMs,
    backgroundJobTtlMs: opts.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: opts.backgroundJobTtlMaxMs,
    sandboxCapabilityTtlMs: opts.sandboxCapabilityTtlMs,
    ...(turn
      ? {
          readOnly: turn.readOnly,
          sessionTools: Boolean(turn.tools.sessionSyscalls),
          surfaceTools: turn.surfaceTools,
          delegateWork: turn.delegateWork,
          surfaceName: turn.surfaceName,
          ...(turn.clientTools?.length ? { clientTools: turn.clientTools } : {}),
        }
      : { surfaceTools: true, surfaceName: "slack" }),
  };
}

export function nativeChildToolAllowed(name: string, args?: unknown): boolean {
  if (!["execute", "files", "apps", "memory", "history", "background"].includes(name)) return false;
  if (args === undefined || (name !== "apps" && name !== "files")) return true;
  const action = args && typeof args === "object" ? (args as Record<string, unknown>).action : undefined;
  if (name === "apps") return action === "publish";
  if (action === "read" || action === "write") return true;
  return false;
}

export function bridgedTools(ref: ToolContextRef, options: AgentToolsOptions): BridgedTool[] {
  return createAgentTools(ref, options) as unknown as BridgedTool[];
}

export interface ResumedToolResult {
  history: Item[];
  message: {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: NonNullable<Awaited<ReturnType<BridgedTool["execute"]>>["content"]>;
    isError: boolean;
    timestamp: number;
  };
}

export async function withResumedToolCall(
  turn: HarnessTurnInput,
  ref: ToolContextRef,
  tools: readonly BridgedTool[],
): Promise<HarnessTurnInput> {
  const resumed = await resumeInterruptedToolCall(turn, ref, tools);
  return resumed ? { ...turn, history: resumed.history } : turn;
}

export async function resumeInterruptedToolCall(
  turn: HarnessTurnInput,
  ref: ToolContextRef,
  tools: readonly BridgedTool[],
): Promise<ResumedToolResult | null> {
  const call = turn.resumeToolCall;
  if (!call) return null;
  const tool = tools.find((candidate) => candidate.name === call.tool);
  const emit = ref.emit;
  const abortSignal = ref.abortSignal;
  let recorded: Item | undefined;
  ref.emit = async (item) => {
    if (item.kind === "ToolCall") return;
    const appended = await emit?.(item);
    if (item.kind === "ToolResult" && !recorded) recorded = appended as Item;
    return appended;
  };
  ref.abortSignal = turn.cancel;
  let content: ResumedToolResult["message"]["content"] = [{ type: "text", text: INTERRUPTED_TOOL_RESULT }];
  let isError = true;
  try {
    if (tool && !turn.cancel?.aborted) {
      content = (await tool.execute(call.callId, call.input)).content ?? [];
      isError = false;
    } else {
      console.error(
        `[harness] resume: ${tool ? "turn cancelled" : `tool ${call.tool} unavailable on this turn`}; recording call ${call.callId} as interrupted`,
      );
    }
    if (!recorded) {
      await ref.emit({
        kind: "ToolResult",
        tool: call.tool,
        callId: call.callId,
        isError,
        text: content[0]?.text ?? "",
        body: { interrupted: true },
      });
    }
  } catch (error) {
    isError = recorded ? recorded.isError === true : true;
    content = [{ type: "text", text: recorded ? (recorded.text ?? "") : `[error] ${errMessage(error)}` }];
    if (!recorded)
      await ref.emit({ kind: "ToolResult", tool: call.tool, callId: call.callId, isError, text: content[0]!.text });
  } finally {
    ref.emit = emit;
    ref.abortSignal = abortSignal;
  }
  if (!recorded) return null;
  if (!isError)
    console.log(`[harness] resume: re-ran retry-safe ${call.tool} call ${call.callId} as seq ${recorded.seq}`);
  return {
    history: [...turn.history, recorded],
    message: {
      role: "toolResult",
      toolCallId: call.callId,
      toolName: call.tool,
      content,
      isError,
      timestamp: recorded.createdAt,
    },
  };
}

export function bridgedToolContent(result: Awaited<ReturnType<BridgedTool["execute"]>>) {
  return (result.content ?? []).flatMap<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >((item) => {
    if (item.type === "image" && item.data && item.mimeType)
      return [{ type: "image", data: item.data, mimeType: item.mimeType }];
    return typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];
  });
}

export type OneShotRunner = (
  systemPrompt: string,
  prompt: string,
  signal?: AbortSignal,
  observe?: Pick<HarnessTurnInput, "recordModelCall" | "recordLlmRequest">,
  modelOverride?: string,
) => Promise<string | undefined>;

export function oneShotRunner(runPrompt: (turn: HarnessTurnInput) => Promise<HarnessTurnResult>): OneShotRunner {
  return async (systemPrompt, prompt, signal, observe, modelOverride) => {
    const session = { id: `oneshot-${randomBytes(8).toString("hex")}` } as HarnessTurnInput["session"];
    const scope = { kind: "org", id: "oneshot" } as unknown as ScopeId;
    const emitted: Item[] = [];
    const result = await runPrompt({
      session,
      input: prompt,
      systemPrompt,
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      ...(signal ? { cancel: signal } : {}),
      ...(modelOverride ? { runtime: { modelId: modelOverride } } : {}),
      readOnly: true,
      emit: async (item) => {
        const saved = storedItem(item, { sessionId: session.id, seq: emitted.length + 1, createdAt: Date.now() });
        emitted.push(saved);
        return saved;
      },
      recordModelCall: observe?.recordModelCall ?? (() => {}),
      ...(observe?.recordLlmRequest
        ? {
            recordLlmRequest: (rec: HarnessLlmRequestRecord, requestSignal?: AbortSignal) =>
              observe.recordLlmRequest!({ ...rec, turnSeq: null }, requestSignal),
          }
        : {}),
    });
    return result.reply || undefined;
  };
}

export function oneShotModelUtilities(
  single: OneShotRunner,
  judgeModelId?: string,
): Pick<HarnessModelUtilities, "oneShot" | "judge" | "screenSecurity" | "generateTitle" | "summarizeApproval"> {
  return {
    oneShot: (system, prompt) => single(system, prompt),
    judge: (system, prompt, signal) => single(system, prompt, signal, undefined, judgeModelId),
    screenSecurity: async ({ payload, signal, recordModelCall, recordLlmRequest }) =>
      parseSecurityScreenVerdict(
        await single(SECURITY_SCREEN_SYSTEM_PROMPT, payload, signal, {
          recordModelCall,
          ...(recordLlmRequest
            ? {
                recordLlmRequest: (rec, requestSignal) =>
                  recordLlmRequest({ ...rec, step: SECURITY_SCREEN_STEP }, requestSignal),
              }
            : {}),
        }),
      ),
    generateTitle: async (transcript) =>
      sanitizeTitle(await single(TITLE_GENERATION_PROMPT, titleUserPrompt(transcript))),
    summarizeApproval: (command, reason, purpose) =>
      single(
        "Explain this command in one plain-English sentence for an approver.",
        [command, reason, purpose].filter(Boolean).join("\n"),
      ),
  };
}
