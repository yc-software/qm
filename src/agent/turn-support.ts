import { steerWithheldItem } from "../core/turn-error.ts";
import type { ResumableToolCall } from "../core/turn-resume.ts";
import type { ReplayImageRef } from "./replay.ts";
import type { ToolContextRef } from "./agent-tools.ts";
import type { AgentTurnInput, ApprovedToolCall } from "./agent.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { INTERRUPTED_TOOL_RESULT } from "./context-compaction.ts";
import type { Item, NewItem } from "../sessions/items.ts";
import { DuplicateCallError } from "../sessions/session-store.ts";
import type { StepFields } from "./step-recorder.ts";

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
  attachments?: AgentTurnInput["attachments"];
  images?: AgentTurnInput["images"];
  author?: string;
  authorName?: string;
  withheld?: boolean;
  acknowledge?: () => Promise<void>;
}

export function imageRefs(images: AgentTurnInput["images"]): { images?: ReplayImageRef[] } {
  if (!images?.length) return {};
  return {
    images: images.map((image) => ({
      mimeType: image.mimeType,
      ...(image.artifactId ? { artifactId: image.artifactId } : {}),
    })),
  };
}

export async function recordSteerIntake(turn: AgentTurnInput, steer: SteerIntake): Promise<void> {
  if (steer.withheld) await turn.emit(steerWithheldItem(steer.authorName ?? steer.author ?? ""));
  else
    await turn.emit({
      kind: "SteeringMessage",
      text: steer.text,
      author: steer.author ?? null,
      body: {
        ...(steer.authorName ? { name: steer.authorName } : {}),
        ...(steer.prompt !== undefined && steer.prompt !== steer.text ? { prompt: steer.prompt } : {}),
        ...(steer.ts ? { ts: steer.ts } : {}),
        ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
        ...imageRefs(steer.images),
      },
    });
  await steer.acknowledge?.().catch(swallowAs("steer acknowledge", undefined));
}

const STOPPED_FALLBACK_REASON = "unexpectedly";

export async function recordStoppedTurn(
  turn: AgentTurnInput,
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
        body: { stopped: true, ...(turn.cancel?.aborted ? { cancelled: true } : {}), ...replay?.body },
      })
    : null;
  const note = await turn.emit({ kind: "Stop", body: { reason } });
  return note ?? answer;
}

type ToolResultContent = NonNullable<Awaited<ReturnType<BridgedTool["execute"]>>["content"]>;

export interface ResumedToolResult {
  history: Item[];
  message: {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: ToolResultContent;
    isError: boolean;
    timestamp: number;
  };
}

export interface ApprovedToolCallOutcome {
  items: Item[];
  text: string;
  isError: boolean;
}

function toolCallRoute(
  call: ResumableToolCall,
  tools: readonly BridgedTool[],
  viaConnector: boolean,
): { tool: BridgedTool; args: unknown } | null {
  const direct = tools.find((candidate) => candidate.name === call.tool);
  if (direct) return { tool: direct, args: call.input };
  if (!viaConnector) return null;
  const connector = tools.find((candidate) => candidate.name === "mcp_call");
  return connector ? { tool: connector, args: { tool: call.tool, args: call.input } } : null;
}

const ALREADY_RAN = "[error] this approved call was already started earlier, so it was not run again";

async function runToolCallOnce(
  call: ResumableToolCall,
  ref: ToolContextRef,
  tools: readonly BridgedTool[],
  opts: {
    cancel?: AbortSignal;
    fresh?: Record<string, unknown>;
    notRun: (reason: "unavailable" | "cancelled") => string;
    fallbackBody?: Record<string, unknown>;
  },
): Promise<ApprovedToolCallOutcome & { result?: Item; content: ToolResultContent }> {
  const emit = ref.emit;
  const abortSignal = ref.abortSignal;
  const tag = opts.fresh ?? {};
  const items: Item[] = [];
  let result: Item | undefined;
  const append = async (item: NewItem) => {
    const saved = await emit?.(item);
    if (saved) items.push(saved);
    return saved;
  };
  const hasCall = () => items.some((item) => item.kind === "ToolCall");
  const recordCall = async () => {
    if (opts.fresh && !hasCall())
      await append({ kind: "ToolCall", tool: call.tool, callId: call.callId, body: { ...call.input, ...tag } });
  };
  const recordResult = async (isError: boolean, text: string, fallback = true) => {
    await recordCall();
    result = await append({
      kind: "ToolResult",
      tool: call.tool,
      callId: call.callId,
      isError,
      text,
      body: { ...(fallback ? opts.fallbackBody : {}), ...tag },
    });
  };
  ref.emit = async (item) => {
    if (item.kind === "ToolCall") {
      if (!opts.fresh || item.callId === call.callId) return undefined;
      return emit?.(item);
    }
    if (item.kind !== "ToolResult" || result || (opts.fresh && item.callId !== call.callId)) return emit?.(item);
    await recordCall();
    result = await append({ ...item, body: { ...item.body, ...tag } });
    return result;
  };
  ref.abortSignal = opts.cancel;
  let text: string;
  let content: ToolResultContent;
  let isError = true;
  try {
    const route = toolCallRoute(call, tools, !!opts.fresh);
    if (!route || opts.cancel?.aborted) {
      const reason = route ? "cancelled" : "unavailable";
      console.error(
        `[agent] ${opts.fresh ? "approved call" : "resume"}: ${call.tool} ${reason}; call ${call.callId} did not run`,
      );
      text = opts.notRun(reason);
      content = [{ type: "text", text }];
      if (!result) await recordResult(true, text);
    } else {
      try {
        await recordCall();
      } catch (error) {
        if (!(error instanceof DuplicateCallError)) throw error;
        console.error(`[agent] approved call: ${call.tool} call ${call.callId} was already recorded; not run again`);
        return { items, text: ALREADY_RAN, content: [{ type: "text", text: ALREADY_RAN }], isError: true };
      }
      content = (await route.tool.execute(call.callId, route.args)).content ?? [];
      text = content.flatMap((block) => (typeof block.text === "string" ? [block.text] : [])).join("\n");
      isError = false;
      if (!result) await recordResult(isError, text);
    }
  } catch (error) {
    isError = result ? result.isError === true : true;
    text = result ? (result.text ?? "") : `[error] ${errMessage(error)}`;
    content = [{ type: "text", text }];
    if (!result) await recordResult(isError, text, false);
  } finally {
    ref.emit = emit;
    ref.abortSignal = abortSignal;
  }
  if (result?.isError === true) isError = true;
  return { items, text, content, isError, ...(result ? { result } : {}) };
}

export async function resumeInterruptedToolCall(
  turn: AgentTurnInput,
  ref: ToolContextRef,
  tools: readonly BridgedTool[],
): Promise<ResumedToolResult | null> {
  const call = turn.resumeToolCall;
  if (!call) return null;
  const ran = await runToolCallOnce(call, ref, tools, {
    ...(turn.cancel ? { cancel: turn.cancel } : {}),
    notRun: () => INTERRUPTED_TOOL_RESULT,
    fallbackBody: { interrupted: true },
  });
  const recorded = ran.result;
  if (!recorded) return null;
  if (!ran.isError)
    console.log(`[agent] resume: re-ran retry-safe ${call.tool} call ${call.callId} as seq ${recorded.seq}`);
  return {
    history: [...turn.history, recorded],
    message: {
      role: "toolResult",
      toolCallId: call.callId,
      toolName: call.tool,
      content: ran.content,
      isError: ran.isError,
      timestamp: recorded.createdAt,
    },
  };
}

export async function runApprovedToolCall(
  call: ApprovedToolCall,
  ref: ToolContextRef,
  tools: readonly BridgedTool[],
  opts: { cancel?: AbortSignal },
): Promise<ApprovedToolCallOutcome> {
  const { items, text, isError } = await runToolCallOnce(call, ref, tools, {
    ...opts,
    fresh: { approvedRequestId: call.requestId },
    notRun: (reason) =>
      reason === "unavailable"
        ? `[error] the approved tool ${call.tool} is not available on this turn, so it did not run`
        : "[error] the turn was cancelled before the approved call ran",
  });
  return { items, text, isError };
}

export function approvedCallSteerNote(
  outcome: { summary: string; approver: string },
  ran: ApprovedToolCallOutcome,
  withResult: boolean,
): string {
  const head =
    `[system] ${outcome.approver} approved the pending call ${outcome.summary}, and QM ran it exactly as approved` +
    (ran.isError ? "; it returned an error" : "");
  return withResult
    ? `${head}. Result:\n${ran.text}\nDo not call it again; continue with this result.`
    : `${head}. Its result is recorded in this conversation. Do not call it again.`;
}

export function deniedCallSteerNote(outcome: { summary: string; approver: string }): string {
  return `[system] ${outcome.approver} denied the pending call ${outcome.summary}, so it did not run. Do not retry it unless they ask again.`;
}
