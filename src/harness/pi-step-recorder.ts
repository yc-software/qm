import { randomUUID } from "node:crypto";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NewItem } from "../sessions/items.ts";
import type { HarnessTurnInput } from "./harness.ts";
import {
  recordedToolArguments,
  type ReplayStep,
  type StoredResultContent,
  type ToolCallWire,
  type ToolResultWire,
} from "./replay.ts";

type Persist = (write: () => Promise<unknown>) => void;
type Positioned = { index: number; block: TextContent };

export interface StepFields {
  step: number | null;
  body: Record<string, unknown>;
}

function stepFields(step: ReplayStep, wire: Record<string, unknown> = {}): StepFields {
  const { index, ...message } = step;
  return { step: index ?? null, body: { wire: { ...wire, message } } };
}

function jsonbKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbKeyOrder);
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value).sort(
    (a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  return Object.fromEntries(keys.map((key) => [key, jsonbKeyOrder((value as Record<string, unknown>)[key])]));
}

function toolCallWire(call: Pick<NewItem, "tool" | "body">, block: ToolCall): ToolCallWire {
  const { type: _type, id: _id, name, arguments: args, ...extra } = block;
  const recorded = recordedToolArguments({ body: call.body ?? {} });
  const argumentsJson = JSON.stringify(args);
  const reproducible =
    argumentsJson === JSON.stringify(recorded) && argumentsJson === JSON.stringify(jsonbKeyOrder(recorded));
  return {
    ...extra,
    ...(name !== call.tool ? { name } : {}),
    ...(reproducible ? {} : { argumentsJson }),
  };
}

function storedResultContent(content: ToolResultMessage["content"]): StoredResultContent[] {
  return content.map((block) => {
    if (block.type !== "image") return block;
    const { data: _data, ...image } = block;
    return image;
  });
}

function toolResultWire(
  result: NewItem,
  content: ToolResultMessage["content"],
  isError: boolean,
): { wire?: ToolResultWire } {
  if (result.body?.interrupted === true) return {};
  const stored = storedResultContent(content);
  const only = stored[0];
  const sameContent =
    stored.length === 1 &&
    only!.type === "text" &&
    Object.keys(only!).length === 2 &&
    only!.text === (result.text ?? "");
  const sameError = isError === (result.isError === true);
  if (sameContent && sameError) return {};
  return { wire: { ...(sameError ? {} : { isError }), ...(sameContent ? {} : { content: stored }) } };
}

function resultText(content: ToolResultMessage["content"]): string {
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export type StepRecorder = ReturnType<typeof createStepRecorder>;

export function createStepRecorder(turn: Pick<HarnessTurnInput, "emit" | "shutdown">, persist: Persist) {
  const calls = new Map<string, { step: ReplayStep; block: ToolCall }>();
  const called = new Set<string>();
  const executing = new Map<string, NewItem>();
  let pending: { step: ReplayStep; parts: Positioned[] } | null = null;
  let last: ReplayStep | undefined;
  let streamingStep: string | undefined;
  const write = (item: NewItem) => persist(() => turn.emit(item));
  const steppedCall = (item: NewItem, call: { step: ReplayStep; block: ToolCall }): NewItem => {
    const fields = stepFields(call.step, toolCallWire(item, call.block));
    return { ...item, step: fields.step, body: { ...item.body, ...fields.body } };
  };
  const flush = (): void => {
    if (!pending) return;
    for (const { index, block } of pending.parts) {
      const { type: _type, text, ...rest } = block;
      const fields = stepFields({ ...pending.step, index });
      write({ kind: "AgentMessage", variant: "narration", text, step: fields.step, body: { ...rest, ...fields.body } });
    }
    pending = null;
  };
  const recordResult = (callId: string, content: ToolResultMessage["content"], isError: boolean): void => {
    const call = calls.get(callId);
    if (!call) return;
    calls.delete(callId);
    if (!called.has(callId)) write(steppedCall({ kind: "ToolCall", tool: call.block.name, callId }, call));
    called.delete(callId);
    const logged = executing.get(callId);
    executing.delete(callId);
    const result: NewItem = logged ?? {
      kind: "ToolResult",
      tool: call.block.name,
      callId,
      isError,
      text: resultText(content),
    };
    write({ ...result, body: { ...result.body, ...toolResultWire(result, content, isError) } });
  };
  return {
    emit: async (item: NewItem): Promise<unknown> => {
      const callId = item.callId ?? "";
      const call = calls.get(callId);
      if (call && item.kind === "ToolCall") {
        called.add(callId);
        return turn.emit(steppedCall(item, call));
      }
      if (call && item.kind === "ToolResult") {
        executing.set(callId, item);
        return undefined;
      }
      return turn.emit(item);
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
          const { type: _type, thinking, ...rest } = block;
          const fields = stepFields({ ...step, index });
          write({ kind: "Reasoning", text: thinking, step: fields.step, body: { ...rest, ...fields.body } });
        } else if (block.type === "text") {
          if (block.text || block.textSignature !== undefined) parts.push({ index, block });
        } else calls.set(block.id, { step: { ...step, index }, block });
      });
      pending = { step, parts };
      if (message.content.some((block) => block.type === "toolCall")) flush();
    },
    startStreaming(): void {
      streamingStep = undefined;
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
      for (const item of executing.values()) write(item);
      executing.clear();
    },
    closing(reply: string): StepFields | null {
      const closing = pending;
      pending = null;
      if (!closing) return last ? stepFields(last) : null;
      const [only] = closing.parts;
      if (closing.parts.length === 1 && only!.block.text === reply) {
        const { type: _type, text: _text, ...textBlock } = only!.block;
        const fields = stepFields({ ...closing.step, index: only!.index });
        return Object.keys(textBlock).length ? { ...fields, body: { ...fields.body, textBlock } } : fields;
      }
      const fields = stepFields(closing.step);
      return {
        ...fields,
        body: { ...fields.body, parts: closing.parts.map(({ index, block }) => ({ index, ...block })) },
      };
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
