import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { piUsageToCallUsage } from "../model/model-runtime.ts";
import { servedFast } from "../model/served-speed.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { Item } from "../sessions/items.ts";
import { startPhase } from "../../plugins/chassis/src/error-reporting.ts";
import { swallow } from "../util/errors.ts";
import type { AgentTurnInput } from "./agent.ts";
import { meterGoalCall, meterGrindCall, type GrindMeter } from "./goal.ts";
import type { StepRecorder } from "./step-recorder.ts";
import type { TurnSession } from "./turn-session.ts";

export function subscribeTurnStream({
  entry,
  steps,
  turn,
  grindMeter,
  callUsage,
}: {
  entry: TurnSession;
  steps: StepRecorder;
  turn: AgentTurnInput;
  grindMeter: GrindMeter;
  callUsage: Array<LlmCallUsage | null>;
}): () => void {
  return entry.agentSession.subscribe((event) => {
    if (event.type === "message_update" && entry.ref.firstTokenPhase) {
      entry.ref.firstTokenPhase.end();
      entry.ref.firstTokenPhase = undefined;
    }
    if (event.type === "message_start" && (event.message as { role?: string }).role === "assistant") {
      steps.startStreaming();
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
      turn.onTextBlockStart?.();
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
      const block = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
      if (block?.type === "toolCall") turn.onToolCallStart?.(block.name);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      turn.onDelta?.(event.assistantMessageEvent.delta);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      const { contentIndex, delta, partial } = event.assistantMessageEvent;
      const block = partial.content[contentIndex];
      if (block?.type === "thinking" && !block.redacted)
        turn.onReasoningDelta?.(steps.streamingStepId(), contentIndex, delta);
    } else if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      const served = event.message as { usage?: Partial<Usage>; serviceTier?: string; servedSpeed?: string };
      const stepModel = entry.agentSession.model;
      const usage = piUsageToCallUsage(
        served.usage,
        stepModel,
        servedFast(entry.ref.fast, served.servedSpeed),
        served.serviceTier,
      );
      meterGrindCall(grindMeter, usage);
      const meteredGoal = entry.ref.goal;
      if (meteredGoal?.status === "active") meterGoalCall(meteredGoal, usage);
      callUsage.push(usage);
      entry.ref.firstTokenPhase?.end();
      entry.ref.firstTokenPhase = undefined;
      if ((event.message as AssistantMessage).stopReason === "toolUse") entry.ref.stepPhase = startPhase("step.gap");
    }
  });
}

export async function recordCapturedRequests({
  entry,
  turn,
  callUsage,
  userEntry,
  effectiveModel,
}: {
  entry: TurnSession;
  turn: AgentTurnInput;
  callUsage: Array<LlmCallUsage | null>;
  userEntry: Item | undefined;
  effectiveModel: string;
}): Promise<void> {
  const captured = entry.ref.llmCapture ?? [];
  entry.ref.llmCapture = undefined;
  if (!turn.recordLlmRequest) return;
  const usageAligned = callUsage.length === captured.length;
  for (let step = 0; step < captured.length; step++) {
    try {
      await turn.recordLlmRequest({
        turnSeq: userEntry?.seq ?? null,
        step,
        model: captured[step]!.transport?.modelId ?? effectiveModel,
        promptEnvelope: captured[step]!.envelope,
        truncated: captured[step]!.truncated,
        transport: captured[step]!.transport ?? null,
        usage: usageAligned ? (callUsage[step] ?? null) : null,
      });
    } catch (e) {
      swallow("pi: llm request record", e);
    }
  }
}
