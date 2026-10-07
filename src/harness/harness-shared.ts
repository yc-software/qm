import { randomBytes } from "node:crypto";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import {
  parseSecurityScreenVerdict,
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
} from "../security/security-posture.ts";
import type { TaskStatus, TaskStore } from "../tasks/task-store.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import { createAgentTools, type AgentToolsOptions, type ToolContextRef } from "./agent-tools.ts";
import { rehydrateOpenGoal } from "./goal.ts";
import type { HarnessLlmRequestRecord, HarnessModelUtilities, HarnessTurnInput, HarnessTurnResult } from "./harness.ts";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";
import { tapeCheckpointPayload, tapeEntryMirrorRecord, type NewTapeRecord } from "../sessions/session-store.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { INTERRUPTED_TOOL_RESULT } from "./context-compaction.ts";

export interface HarnessToolPlumbing {
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
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
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; terminate?: boolean }>;
};

export interface SteerIntake {
  text: string;
  ts?: string;
  attachments?: HarnessTurnInput["attachments"];
  acknowledge?: () => Promise<void>;
}

export async function recordSteerIntake(
  turn: HarnessTurnInput,
  steer: SteerIntake,
): Promise<Pick<NewTapeRecord, "entrySeq" | "meta">> {
  const entry = await turn.emit({
    type: "user",
    payload: {
      text: steer.text,
      ...(steer.ts ? { ts: steer.ts } : {}),
      steered: true,
      ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
    },
    scopeLabel: turn.scopeLabel,
  });
  await steer.acknowledge?.().catch(swallowAs("steer acknowledge", undefined));
  return {
    entrySeq: entry.seq,
    meta: {
      bareText: steer.text,
      ...(steer.ts ? { ts: steer.ts } : {}),
      ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
      entryCreatedAt: entry.createdAt,
    },
  };
}

export async function tapeReplyCheckpoint(
  turn: Pick<HarnessTurnInput, "tape" | "scopeLabel">,
  entry: Pick<SessionEntry, "seq" | "createdAt" | "payload">,
): Promise<void> {
  if (!turn.tape) return;
  await turn.tape({
    kind: "annotation",
    payload: tapeCheckpointPayload("subturnEnd", { type: "assistant", payload: entry.payload, at: entry.createdAt }),
    scopeLabel: turn.scopeLabel,
    entrySeq: entry.seq,
  });
}

export async function recordStoppedReply(turn: HarnessTurnInput, text: string): Promise<SessionEntry | null> {
  if (turn.shutdown?.aborted) return null;
  return turn.emit({ type: "assistant", payload: { text, stopped: true }, scopeLabel: turn.scopeLabel });
}

export function withTapedEntryMirrors(turn: HarnessTurnInput): HarnessTurnInput {
  const tape = turn.tape;
  if (!tape) return turn;
  const emit = turn.emit;
  return {
    ...turn,
    emit: async (entry) => {
      const saved = await emit(entry);
      try {
        await tape(tapeEntryMirrorRecord(saved));
      } catch (error) {
        swallow("harness: entry mirror", error);
      }
      return saved;
    },
  };
}

export function harnessToolContext(turn: HarnessTurnInput): ToolContextRef {
  return {
    current: turn.tools,
    runtimeRunId: turn.runId,
    runtimeActorId: turn.runtimeActorId,
    pendingApprovals: [],
    pausedOnApproval: false,
    silentRequested: false,
    pollFire: Boolean(turn.pollFire),
    goal: turn.goal ?? rehydrateOpenGoal(turn.history),
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenToolResult: turn.screenToolResult,
    verifyGoal: turn.verifyGoal,
    toolApprovalGate: turn.toolApprovalGate,
    shutdown: turn.shutdown,
  };
}

export function harnessToolOptions(opts: HarnessToolPlumbing, turn?: HarnessTurnInput): AgentToolsOptions {
  return {
    scratchExec: opts.scratchExec,
    ownerAuthExec: opts.ownerAuthExec,
    reachExec: opts.reachExec,
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
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
  return (
    action === "share" && typeof (args as Record<string, unknown>).path === "string" && !("id" in (args as object))
  );
}

export function bridgedTools(ref: ToolContextRef, options: AgentToolsOptions): BridgedTool[] {
  return createAgentTools(ref, options) as unknown as BridgedTool[];
}

export interface ResumedToolResult {
  history: SessionEntry[];
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
  let recorded: SessionEntry | undefined;
  ref.emit = async (entry) => {
    if (entry.type === "tool_call") return;
    const appended = await emit?.(entry);
    if (entry.type === "tool_result" && !recorded) recorded = appended as SessionEntry;
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
        type: "tool_result",
        payload: { tool: call.tool, callId: call.callId, isError, result: content[0]?.text ?? "", interrupted: true },
        scopeLabel: turn.scopeLabel,
      });
    }
  } catch (error) {
    const payload = recorded?.payload as { result?: unknown; isError?: unknown } | undefined;
    isError = payload ? payload.isError === true : true;
    content = [{ type: "text", text: payload ? String(payload.result ?? "") : `[error] ${errMessage(error)}` }];
    if (!recorded)
      await ref.emit({
        type: "tool_result",
        payload: { tool: call.tool, callId: call.callId, isError, result: content[0]!.text },
        scopeLabel: turn.scopeLabel,
      });
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

export function bridgedToolText(result: Awaited<ReturnType<BridgedTool["execute"]>>): string {
  return (result.content ?? [])
    .filter((item): item is { type?: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export async function transitionTask(
  store: TaskStore | undefined,
  id: string,
  expected: TaskStatus,
  next: TaskStatus,
  runId: string,
): Promise<void> {
  if (!store) return;
  const updated = await store.transitionStatus(id, expected, next, runId);
  if (!updated) throw new Error(`task ${id} was not ${expected} while transitioning to ${next}`);
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
    const emitted: SessionEntry[] = [];
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
      emit: async (entry) => {
        const saved = {
          ...entry,
          sessionId: session.id,
          seq: emitted.length + 1,
          createdAt: Date.now(),
        } as SessionEntry;
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
