import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

type SessionState = "working" | "awaiting_approval" | "idle" | "metadata" | "ui";

export type UiSignal =
  { kind: "canvas" } | { kind: "observe"; callId: string; selector?: string; css?: boolean; screenshot?: boolean };

export interface SessionStateEvent {
  threadRef: string;
  sessionId?: string;
  participants?: string[];
  participantsShed?: boolean;
  state: SessionState;
  ui?: UiSignal;
  at: number;
}

export type SessionStateBus = EventBus<SessionStateEvent>;

export function createMemorySessionStateBus(): SessionStateBus {
  return createMemoryEventBus<SessionStateEvent>("session-state");
}
