import { randomUUID } from "node:crypto";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolContextRef } from "./agent-tools.ts";
import type { HarnessTurnInput } from "./harness.ts";
import {
  recordedToolArguments,
  type ReplayStep,
  type StoredResultContent,
  type ToolCallWire,
  type ToolResultWire,
} from "./replay.ts";

type RecordedEntry = Parameters<NonNullable<ToolContextRef["emit"]>>[0];
type TurnEntry = Parameters<HarnessTurnInput["emit"]>[0];
type Persist = (write: () => Promise<unknown>) => void;
type Positioned = { index: number; block: TextContent };

function toolCallWire(payload: Record<string, unknown>, block: ToolCall): { wire?: ToolCallWire } {
  const { type: _type, id: _id, name, arguments: args, ...extra } = block;
  const recorded = recordedToolArguments(payload);
  const argumentsJson = JSON.stringify(args);
  const reproducible = argumentsJson === JSON.stringify(recorded);
  const wire: ToolCallWire = {
    ...extra,
    ...(name !== payload.tool ? { name } : {}),
    ...(reproducible ? {} : { argumentsJson }),
  };
  return Object.keys(wire).length ? { wire } : {};
}

function storedResultContent(content: ToolResultMessage["content"]): StoredResultContent[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const { data: _data, ...image } = block;
    return image;
  });
}

function toolResultWire(
  payload: Record<string, unknown>,
  content: ToolResultMessage["content"],
  isError: boolean,
): { wire?: ToolResultWire } {
  if (payload.interrupted === true) return {};
  const stored = storedResultContent(content);
  const only = stored[0];
  const sameContent =
    stored.length === 1 &&
    only!.type === "text" &&
    Object.keys(only!).length === 2 &&
    only!.text === String(payload.result ?? "");
  const sameError = isError === (payload.isError === true);
  if (sameContent && sameError) return {};
  return { wire: { ...(sameError ? {} : { isError }), ...(sameContent ? {} : { content: stored }) } };
}

function resultText(content: ToolResultMessage["content"]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export type StepRecorder = ReturnType<typeof createStepRecorder>;

export function createStepRecorder(turn: Pick<HarnessTurnInput, "emit" | "scopeLabel">, persist: Persist) {
  const calls = new Map<string, { step: ReplayStep; block: ToolCall }>();
  const called = new Set<string>();
  const executing = new Map<string, RecordedEntry>();
  let pending: { step: ReplayStep; parts: Positioned[] } | null = null;
  let last: ReplayStep | undefined;
  let streamingStep: string | undefined;
  const write = (entry: RecordedEntry) => persist(() => turn.emit(entry as TurnEntry));
  const flush = (): void => {
    if (!pending) return;
    for (const { index, block } of pending.parts)
      write({ type: "text", payload: { ...block, step: { ...pending.step, index } }, scopeLabel: turn.scopeLabel });
    pending = null;
  };
  const recordResult = (callId: string, content: ToolResultMessage["content"], isError: boolean): void => {
    const call = calls.get(callId);
    if (!call) return;
    calls.delete(callId);
    if (!called.has(callId)) {
      const payload = { tool: call.block.name, callId };
      write({
        type: "tool_call",
        payload: { ...payload, step: call.step, ...toolCallWire(payload, call.block) },
        scopeLabel: turn.scopeLabel,
      });
    }
    called.delete(callId);
    const logged = executing.get(callId);
    executing.delete(callId);
    const payload = (logged?.payload as Record<string, unknown> | undefined) ?? {
      tool: call.block.name,
      callId,
      isError,
      result: resultText(content),
    };
    write({
      type: "tool_result",
      payload: { ...payload, ...toolResultWire(payload, content, isError) },
      scopeLabel: logged?.scopeLabel ?? turn.scopeLabel,
    });
  };
  return {
    emit: async (entry: RecordedEntry): Promise<unknown> => {
      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      const call = calls.get(callId);
      if (call && entry.type === "tool_call") {
        called.add(callId);
        return turn.emit({
          ...entry,
          payload: { ...payload, step: call.step, ...toolCallWire(payload, call.block) },
        } as TurnEntry);
      }
      if (call && entry.type === "tool_result") {
        executing.set(callId, entry);
        return undefined;
      }
      return turn.emit(entry as TurnEntry);
    },
    assistant(message: AssistantMessage): void {
      flush();
      const { api, provider, model, stopReason } = message;
      const step: ReplayStep = { id: streamingStep ?? randomUUID(), api, provider, model, stopReason };
      streamingStep = undefined;
      last = step;
      const parts: Positioned[] = [];
      message.content.forEach((block, index) => {
        if (block.type === "thinking") {
          if (!block.redacted && block.thinkingSignature === undefined && !block.thinking.trim()) return;
          write({ type: "thinking", payload: { ...block, step: { ...step, index } }, scopeLabel: turn.scopeLabel });
        } else if (block.type === "text") {
          if (block.text || block.textSignature !== undefined) parts.push({ index, block });
        } else calls.set(block.id, { step: { ...step, index }, block });
      });
      pending = { step, parts };
      if (message.content.some((block) => block.type === "toolCall")) flush();
    },
    streamingStepId(): string {
      return (streamingStep ??= randomUUID());
    },
    toolReturned: recordResult,
    toolResult(message: ToolResultMessage): void {
      recordResult(message.toolCallId, message.content, message.isError);
    },
    flush,
    settleResults(): void {
      for (const entry of executing.values()) write(entry);
      executing.clear();
    },
    closing(reply: string): Record<string, unknown> {
      const closing = pending;
      pending = null;
      if (!closing) return last ? { step: last } : {};
      const [only] = closing.parts;
      if (closing.parts.length === 1 && only!.block.text === reply) {
        const { type: _type, text: _text, ...textBlock } = only!.block;
        return {
          step: { ...closing.step, index: only!.index },
          ...(Object.keys(textBlock).length ? { textBlock } : {}),
        };
      }
      return { step: closing.step, parts: closing.parts.map(({ index, block }) => ({ index, ...block })) };
    },
  };
}

export function recordingTools(tools: ToolDefinition[], recorder: () => StepRecorder | undefined): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      const callId = args[0];
      try {
        const result = await tool.execute(...args);
        recorder()?.toolReturned(callId, result.content ?? [], false);
        return result;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        recorder()?.toolReturned(callId, [{ type: "text", text }], true);
        throw error;
      }
    },
  })) as ToolDefinition[];
}
