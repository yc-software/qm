import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

type SessionState = "working" | "awaiting_approval" | "idle";

export interface SessionStateEvent {
  threadRef: string;
  sessionId?: string;
  participants?: string[];
  participantsShed?: boolean;
  state: SessionState;
  at: number;
}

export type SessionStateBus = EventBus<SessionStateEvent>;

export function createMemorySessionStateBus(): SessionStateBus {
  return createMemoryEventBus<SessionStateEvent>("session-state");
}
