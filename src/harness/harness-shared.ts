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
import type { HarnessLlmRequestRecord, HarnessModelUtilities, HarnessTurnInput, HarnessTurnResult } from "./harness.ts";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";
import { tapeCheckpointPayload, tapeEntryMirrorRecord } from "../sessions/session-store.ts";
import { swallow } from "../util/errors.ts";

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
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenToolResult: turn.screenToolResult,
    toolApprovalGate: turn.toolApprovalGate,
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
    ...(turn
      ? {
          readOnly: turn.readOnly,
          surfaceTools: turn.surfaceTools,
          surfaceName: turn.surfaceName,
          credentialExecServices: turn.credentialExecServices,
        }
      : { surfaceTools: true, surfaceName: "slack" }),
  };
}

export function bridgedTools(ref: ToolContextRef, options: AgentToolsOptions): BridgedTool[] {
  return createAgentTools(ref, options) as unknown as BridgedTool[];
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
    judge: (system, prompt) => single(system, prompt, undefined, undefined, judgeModelId),
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
