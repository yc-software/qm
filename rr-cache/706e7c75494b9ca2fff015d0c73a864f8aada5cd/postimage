import type { EventBus } from "../util/event-bus.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { tenantScopedBus } from "../tenants/bus.ts";
import type { TurnStream, TurnStreamChange } from "./turn-stream.ts";

export function createRunStreamBus(databaseUrl: string): EventBus<RunStreamEvent> {
  return tenantScopedBus(createPostgresNotifyBus<RunStreamEvent>(databaseUrl, "run_stream", "run-stream"));
}

export type RunStreamEvent = { tenant?: string } & (
  | { runId: string; kind: "delta"; offset: number; text: string; startOffset: number; origin?: string }
  | { runId: string; kind: "reasoning"; step: string; index: number; offset: number; text: string; origin?: string }
  | { runId: string; kind: "sync"; offset: number; reasoning?: Record<string, number> }
  | { runId: string; kind: "refresh" }
  | { runId: string; kind: "state"; origin: string; change: TurnStreamChange }
);

export function emitRunText(
  bus: EventBus<RunStreamEvent>,
  runId: string,
  text: string,
  offset: number,
  startOffset: number,
  origin?: string,
): void {
  for (const [at, chunk] of notifyChunks(text))
    bus.emit({ runId, kind: "delta", offset: offset + at, text: chunk, startOffset, ...(origin ? { origin } : {}) });
}

export function emitRunReasoning(
  bus: EventBus<RunStreamEvent>,
  runId: string,
  block: { step: string; index: number },
  text: string,
  offset: number,
  origin?: string,
): void {
  for (const [at, chunk] of notifyChunks(text))
    bus.emit({
      runId,
      kind: "reasoning",
      step: block.step,
      index: block.index,
      offset: offset + at,
      text: chunk,
      ...(origin ? { origin } : {}),
    });
}

export function serveRunStreamSync(
  bus: EventBus<RunStreamEvent>,
  stream: Pick<TurnStream, "snapshot" | "startOffset" | "reasoning" | "applyRemote">,
  origin: string,
): () => void {
  return bus.subscribe(
    (event) => {
      if (event.kind === "delta" || event.kind === "reasoning" || event.kind === "state") {
        if (event.origin && event.origin !== origin) stream.applyRemote(event.runId, event);
        return;
      }
      if (event.kind !== "sync") return;
      const text = stream.snapshot(event.runId);
      const startOffset = stream.startOffset(event.runId);
      const offset = Math.max(event.offset, startOffset);
      if (text) emitRunText(bus, event.runId, text.slice(offset - startOffset), offset, startOffset, origin);
      for (const block of stream.reasoning(event.runId)) {
        const sent = event.reasoning?.[reasoningKey(block)] ?? 0;
        if (block.text.length > sent) emitRunReasoning(bus, event.runId, block, block.text.slice(sent), sent, origin);
      }
    },
    { allTenants: true },
  );
}

export function reasoningKey(block: { step: string; index: number }): string {
  return `${block.step}:${block.index}`;
}

function* notifyChunks(text: string): Generator<[number, string]> {
  for (let at = 0; at < text.length; at += 1_000) yield [at, text.slice(at, at + 1_000)];
}
