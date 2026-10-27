import type { ReplayImageRef } from "./replay.ts";
import type { StepFields } from "./pi-step-recorder.ts";
import type { Item, NewItem } from "../sessions/items.ts";
import type { TurnToolState } from "./turn-tool-state.ts";
import type { HarnessTurnInput } from "./harness.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { INTERRUPTED_TOOL_RESULT } from "./context-compaction.ts";

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

export async function resumeInterruptedToolCall(
  turn: HarnessTurnInput,
  state: Pick<TurnToolState, "tools" | "routeEmit" | "bindAbort">,
  tools: readonly BridgedTool[],
): Promise<Item[] | null> {
  const call = turn.resumeToolCall;
  if (!call) return null;
  const tool = tools.find((candidate) => candidate.name === call.tool);
  const emit = state.tools.emit;
  const abortSignal = state.tools.abortSignal;
  let recorded: Item | undefined;
  const resumeEmit = async (item: NewItem) => {
    if (item.kind === "ToolCall") return;
    const appended = await emit?.(item);
    if (item.kind === "ToolResult" && !recorded) recorded = appended as Item;
    return appended;
  };
  state.routeEmit(resumeEmit);
  state.bindAbort(turn.cancel);
  let content: NonNullable<Awaited<ReturnType<BridgedTool["execute"]>>["content"]> = [
    { type: "text", text: INTERRUPTED_TOOL_RESULT },
  ];
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
      await resumeEmit({
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
      await resumeEmit({ kind: "ToolResult", tool: call.tool, callId: call.callId, isError, text: content[0]!.text });
  } finally {
    state.routeEmit(emit);
    state.bindAbort(abortSignal);
  }
  if (!recorded) return null;
  if (!isError)
    console.log(`[harness] resume: re-ran retry-safe ${call.tool} call ${call.callId} as seq ${recorded.seq}`);
  return [...turn.history, recorded];
}
