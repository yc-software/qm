import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import type { HarnessTurnInput } from "./harness.ts";
import type { ModelCallLog } from "./model-call-log.ts";
import type { GoalRecord } from "./goal.ts";
import type { StepRecorder } from "./pi-step-recorder.ts";
import { meterGrindCall, type GrindMeter } from "./grind.ts";
import { meterGoalCall } from "./goal.ts";
import { swallow } from "../util/errors.ts";
import type { GapPhase, GapPhases, LlmCallUsage } from "../sessions/session-store.ts";
import type { GapWork } from "../sessions/session-store.ts";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { FAST_COST_MULTIPLIER, scaleCost } from "./pi-model-runtime.ts";

export interface PerCallStat {
  ttftMs: number | null;
  durationMs: number | null;
  stepGapMs: number | null;
  usage: LlmCallUsage | null;
}

export function stepGapMs(prevStepEnd: number | undefined, curStreamStart: number | undefined): number | null {
  if (prevStepEnd === undefined || curStreamStart === undefined) return null;
  return Math.max(0, curStreamStart - prevStepEnd);
}

function unionMs(
  intervals: ReadonlyArray<{ start: number; end: number }>,
  windowStart: number,
  windowEnd: number,
): number {
  const clamped = intervals
    .map((i) => ({ start: Math.max(i.start, windowStart), end: Math.min(i.end, windowEnd) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const i of clamped) {
    if (i.start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else if (i.end > curEnd) {
      curEnd = i.end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

const GATEWAY_ATTEMPT_HEADERS = [
  "x-litellm-attempted-retries",
  "x-litellm-attempted-fallbacks",
  "x-litellm-response-duration-ms",
  "x-litellm-overhead-duration-ms",
  "x-litellm-model-group",
  "x-litellm-model-api-base",
  "x-litellm-call-id",
  "llm_provider-openai-processing-ms",
  "llm_provider-x-request-id",
  "llm_provider-request-id",
  "openai-processing-ms",
  "x-request-id",
  "request-id",
];

export function gatewayAttemptHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string> = {};
  for (const name of GATEWAY_ATTEMPT_HEADERS) {
    const value = lower.get(name);
    if (typeof value === "string" && value) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface DispatchMarks {
  onPayload?: number;
  onResponse?: number;
  messageStart?: number;
  prepareNextTurn?: number;
  transformContext?: number;
}

export function decomposeGapPhases(
  gapWindow: { gapStart?: number; gapEnd: number } | undefined,
  intervals: ReadonlyArray<GapWork>,
  gap: number | null,
  marks?: DispatchMarks,
): GapPhases | undefined {
  if (!gapWindow || gapWindow.gapStart === undefined || gap === null) return undefined;
  const { gapStart, gapEnd } = gapWindow;
  const tagged = intervals
    .filter((w) => w.phase !== "model_dispatch" && w.phase !== "tool_body" && w.phase !== "persist")
    .map((w) => ({ start: w.start, end: w.end }));
  const byPhase = new Map<GapPhase, Array<{ start: number; end: number }>>();
  for (const w of intervals) {
    if (w.end <= gapStart || w.start >= gapEnd) continue;
    if (w.phase === "tool_body" || w.phase === "persist") continue;
    const arr = byPhase.get(w.phase) ?? [];
    arr.push({ start: w.start, end: w.end });
    byPhase.set(w.phase, arr);
  }
  const phases: GapPhases = {};
  let attributed = 0;
  for (const [phase, arr] of byPhase) {
    const ms = unionMs(arr, gapStart, gapEnd);
    if (ms > 0) {
      phases[phase] = ms;
      attributed += ms;
    }
  }
  if (marks?.onPayload !== undefined && marks.onPayload > gapStart) {
    const toolBefore = unionMs(tagged, gapStart, marks.onPayload);
    const glue = Math.max(0, marks.onPayload - gapStart - toolBefore);
    if (glue > 0) {
      phases.dispatch_glue = glue;
      attributed += glue;
      const inWindow = (t: number | undefined): boolean => t !== undefined && t >= gapStart && t <= marks.onPayload!;
      let loopReentry = 0;
      if (inWindow(marks.prepareNextTurn)) {
        const toolBeforeReentry = unionMs(tagged, gapStart, marks.prepareNextTurn!);
        loopReentry = Math.min(glue, Math.max(0, marks.prepareNextTurn! - gapStart - toolBeforeReentry));
      }
      let contextAssemble = 0;
      if (inWindow(marks.transformContext)) {
        contextAssemble = Math.min(glue - loopReentry, Math.max(0, marks.onPayload - marks.transformContext!));
      }
      const glueOther = Math.max(0, glue - loopReentry - contextAssemble);
      if (loopReentry > 0) phases.loop_reentry = loopReentry;
      if (contextAssemble > 0) phases.context_assemble = contextAssemble;
      if (glueOther > 0) phases.glue_other = glueOther;
      if (loopReentry > 0 && inWindow(marks.prepareNextTurn)) {
        const reentryEnd = marks.prepareNextTurn!;
        const bodySpans = intervals
          .filter((w) => w.phase === "tool_body")
          .map((w) => ({ start: Math.max(w.start, gapStart), end: Math.min(w.end, reentryEnd) }))
          .filter((w) => w.end > w.start);
        if (bodySpans.length) {
          const firstEntry = Math.min(...bodySpans.map((w) => w.start));
          const lastExit = Math.max(...bodySpans.map((w) => w.end));
          const bodyUnion = unionMs(bodySpans, gapStart, reentryEnd);
          const taggedInside = unionMs(tagged, firstEntry, lastExit);
          const preTool = Math.min(loopReentry, Math.max(0, firstEntry - gapStart));
          const inToolUntagged = Math.min(loopReentry - preTool, Math.max(0, bodyUnion - taggedInside));
          const postTool = Math.min(loopReentry - preTool - inToolUntagged, Math.max(0, reentryEnd - lastExit));
          if (preTool > 0) phases.pre_tool = preTool;
          if (inToolUntagged > 0) {
            phases.in_tool_untagged = inToolUntagged;
            const byTool = new Map<string, Array<{ start: number; end: number }>>();
            for (const w of intervals) {
              if (w.phase !== "tool_body") continue;
              const clamped = { start: Math.max(w.start, gapStart), end: Math.min(w.end, reentryEnd) };
              if (clamped.end <= clamped.start) continue;
              const key = w.tool ?? "unknown";
              const arr = byTool.get(key) ?? [];
              arr.push(clamped);
              byTool.set(key, arr);
            }
            for (const [name, arr] of byTool) {
              const ms = unionMs(arr, gapStart, reentryEnd);
              if (ms > 0) phases[`tool_body.${name}`] = ms;
            }
          }
          if (postTool > 0) phases.post_tool = postTool;
        }
      }
    }
  }
  if (marks?.onResponse !== undefined && marks.messageStart !== undefined) {
    const open = Math.max(0, marks.messageStart - marks.onResponse);
    if (open > 0) {
      phases.stream_open = open;
      attributed += open;
    }
  }
  const persistSpans = intervals.filter((w) => w.phase === "persist").map((w) => ({ start: w.start, end: w.end }));
  if (persistSpans.length) {
    const ms = unionMs(persistSpans, gapStart, gapEnd);
    if (ms > 0) phases.persist = ms;
  }
  phases.residual = Math.max(0, gap - attributed);
  return phases;
}

export function piUsageToCallUsage(
  u: Partial<Usage> | undefined,
  model: Model<Api> | undefined,
  fast: boolean | undefined,
): LlmCallUsage | null {
  if (!u) return null;
  const row: LlmCallUsage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
    costUsd: u.cost?.total ?? 0,
  };
  if (!fast || !model?.cost) return row;
  const priced: Usage = {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    ...(typeof u.cacheWrite1h === "number" ? { cacheWrite1h: Math.min(u.cacheWrite1h, row.cacheWrite) } : {}),
    totalTokens: row.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const card = fast ? ({ ...model, cost: scaleCost(model.cost, FAST_COST_MULTIPLIER) } as Model<Api>) : model;
  row.costUsd = calculateCost(card, priced).total;
  return row;
}

export function sumCacheUsage(
  stats: ReadonlyArray<{ usage: LlmCallUsage | null }>,
): { cacheRead: number; cacheWrite: number; uncachedInput: number } | null {
  let saw = false;
  let cacheRead = 0;
  let cacheWrite = 0;
  let uncachedInput = 0;
  for (const s of stats) {
    if (!s.usage) continue;
    saw = true;
    cacheRead += s.usage.cacheRead;
    cacheWrite += s.usage.cacheWrite;
    uncachedInput += s.usage.input;
  }
  return saw ? { cacheRead, cacheWrite, uncachedInput } : null;
}

export function createCallTelemetry(
  turn: HarnessTurnInput,
  session: AgentSession,
  calls: Pick<ModelCallLog, "streamStarted" | "takeCaptured" | "takeDispatches">,
  fast: () => boolean | undefined,
  goal: () => GoalRecord | null | undefined,
) {
  const toolWallByStep: number[][] = [];
  const gapWork: GapWork[] = [];
  const collectGapWork = (work: GapWork): void => {
    gapWork.push(work);
    if (work.phase === "exec") {
      const bucket = toolWallByStep[toolWallByStep.length - 1];
      if (bucket) bucket.push(Math.max(0, work.end - work.start));
    }
  };

  const callStats: Array<PerCallStat> = [];
  let curStart: number | undefined;
  let curFirst: number | undefined;
  let prevStepEnd: number | undefined;
  const stepWindows: Array<{ gapStart?: number; gapEnd: number }> = [];

  const onSessionEvent =
    (steps: StepRecorder, grindMeter: GrindMeter): AgentSessionEventListener =>
    (event) => {
      if (event.type === "message_start" && (event.message as { role?: string }).role === "assistant") {
        steps.startStreaming();
        curStart = Date.now();
        curFirst = undefined;
        calls.streamStarted(curStart);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
        turn.onTextBlockStart?.();
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
        const block = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
        if (block?.type === "toolCall") turn.onToolCallStart?.(block.name);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        if (curFirst === undefined) curFirst = Date.now();
        turn.onDelta?.(event.assistantMessageEvent.delta);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
        const { contentIndex, delta, partial } = event.assistantMessageEvent;
        const block = partial.content[contentIndex];
        if (block?.type === "thinking" && !block.redacted)
          turn.onReasoningDelta?.(steps.streamingStepId(), contentIndex, delta);
      } else if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
        const end = Date.now();
        const u = (event.message as { usage?: Partial<Usage> }).usage;
        const stepModel = session.model;
        const usage = piUsageToCallUsage(u, stepModel, fast());
        meterGrindCall(grindMeter, usage);
        const meteredGoal = goal();
        if (meteredGoal?.status === "active") meterGoalCall(meteredGoal, usage);
        callStats.push({
          ttftMs: curStart !== undefined && curFirst !== undefined ? curFirst - curStart : null,
          durationMs: curStart !== undefined ? end - curStart : null,
          stepGapMs: stepGapMs(prevStepEnd, curStart),
          usage,
        });
        stepWindows.push({
          ...(prevStepEnd !== undefined ? { gapStart: prevStepEnd } : {}),
          gapEnd: curStart ?? end,
        });
        prevStepEnd = end;
        toolWallByStep.push([]);
        curStart = undefined;
        curFirst = undefined;
      }
    };
  const drainCaptured = async (turnSeq: number | null, effectiveModel: string): Promise<void> => {
    const captured = calls.takeCaptured();
    if (!turn.recordLlmRequest) return;
    const statsAligned = callStats.length === captured.length;
    const dispatch = calls.takeDispatches();
    const dispatchWork: GapWork[] = dispatch
      .filter((d): d is { start: number; first: number } => d.first !== undefined)
      .map((d) => ({ phase: "model_dispatch" as const, start: d.start, end: d.first }));
    const marksAligned = dispatch.length === captured.length;
    const allGapWork = [...gapWork, ...dispatchWork];
    for (let step = 0; step < captured.length; step++) {
      const stat = statsAligned ? callStats[step] : undefined;
      const d = marksAligned ? dispatch[step] : undefined;
      const marks: DispatchMarks | undefined = d && {
        onPayload: d.start,
        onResponse: d.first,
        messageStart: d.streamStart,
        prepareNextTurn: d.prepareNextTurn,
        transformContext: d.transformContext,
      };
      const gapPhases = statsAligned
        ? decomposeGapPhases(stepWindows[step], allGapWork, stat?.stepGapMs ?? null, marks)
        : undefined;
      try {
        await turn.recordLlmRequest({
          turnSeq,
          step,
          model: captured[step]!.transport?.modelId ?? effectiveModel,
          transport: d?.gateway
            ? { ...captured[step]!.transport, gateway: d.gateway }
            : (captured[step]!.transport ?? null),
          ttftMs: stat?.ttftMs ?? null,
          durationMs: stat?.durationMs ?? null,
          stepGapMs: stat?.stepGapMs ?? null,
          toolWallMs: toolWallByStep[step] ?? null,
          gapPhases: gapPhases ?? null,
          usage: stat?.usage ?? null,
        });
      } catch (e) {
        swallow("pi: llm request record", e);
      }
    }
  };
  return { collectGapWork, callStats, onSessionEvent, drainCaptured };
}
