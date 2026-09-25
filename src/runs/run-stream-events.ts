import type { EventBus } from "../util/event-bus.ts";

export type RunStreamEvent =
  | { runId: string; kind: "delta"; offset: number; text: string }
  | { runId: string; kind: "sync"; offset: number }
  | { runId: string; kind: "refresh" };

export function emitRunText(bus: EventBus<RunStreamEvent>, runId: string, text: string, offset: number): void {
  // JSON escaping can cost six bytes per UTF-16 unit; stay below NOTIFY's byte limit.
  for (let at = 0; at < text.length; at += 1_000) {
    bus.emit({ runId, kind: "delta", offset: offset + at, text: text.slice(at, at + 1_000) });
  }
}
