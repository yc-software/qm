import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";
import { tenantScopedBus } from "../tenants/bus.ts";

type SessionState = "working" | "awaiting_approval" | "idle" | "metadata" | "ui";

export type UiSignal =
  | { kind: "canvas" }
  | { kind: "observe"; callId: string; selector?: string; css?: boolean; screenshot?: boolean; preview?: boolean };

export interface SessionStateEvent {
  threadRef: string;
  sessionId?: string;
  participants?: string[];
  participantsShed?: boolean;
  state: SessionState;
  ui?: UiSignal;
  at: number;
  tenant?: string;
}

export type SessionStateBus = EventBus<SessionStateEvent>;

export function createMemorySessionStateBus(): SessionStateBus {
  return tenantScopedBus(createMemoryEventBus<SessionStateEvent>("session-state"));
}
