import type { EventBus } from "../util/event-bus.ts";

import type { ReplyNotice } from "../notifications/reply-notifications.ts";

type SessionState = "working" | "awaiting_approval" | "idle" | "metadata" | "ui" | "notify";

export type UiSignal =
  | { kind: "canvas" }
  | { kind: "observe"; callId: string; selector?: string; css?: boolean; screenshot?: boolean; preview?: boolean }
  | { kind: "desktop"; callId: string; stop?: boolean };

export interface SessionStateEvent {
  tenantId?: string;
  threadRef: string;
  sessionId?: string;
  participants?: string[];
  participantsShed?: boolean;
  state: SessionState;
  ui?: UiSignal;
  notice?: ReplyNotice;
  at: number;
}

export type SessionStateBus = EventBus<SessionStateEvent>;
