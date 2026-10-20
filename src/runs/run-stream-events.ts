import type { EventBus } from "../util/event-bus.ts";

export type RunStreamEvent =
  | { runId: string; kind: "delta"; offset: number; text: string; startOffset: number }
  | { runId: string; kind: "reasoning"; step: string; index: number; offset: number; text: string }
  | { runId: string; kind: "sync"; offset: number; reasoning?: Record<string, number> }
  | { runId: string; kind: "refresh" };

export function emitRunText(
  bus: EventBus<RunStreamEvent>,
  runId: string,
  text: string,
  offset: number,
  startOffset: number,
): void {
  for (const [at, chunk] of notifyChunks(text))
    bus.emit({ runId, kind: "delta", offset: offset + at, text: chunk, startOffset });
}

export function emitRunReasoning(
  bus: EventBus<RunStreamEvent>,
  runId: string,
  block: { step: string; index: number },
  text: string,
  offset: number,
): void {
  for (const [at, chunk] of notifyChunks(text))
    bus.emit({ runId, kind: "reasoning", step: block.step, index: block.index, offset: offset + at, text: chunk });
}

export function reasoningKey(block: { step: string; index: number }): string {
  return `${block.step}:${block.index}`;
}

function* notifyChunks(text: string): Generator<[number, string]> {
  // JSON escaping can cost six bytes per UTF-16 unit; stay below NOTIFY's byte limit.
  for (let at = 0; at < text.length; at += 1_000) yield [at, text.slice(at, at + 1_000)];
}
