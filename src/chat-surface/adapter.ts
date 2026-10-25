import type { IncomingHttpHeaders } from "node:http";
import type { ConversationKind } from "../types.ts";

export interface SurfaceUser {
  id: string;
  email?: string;
  displayName?: string;
  guest?: boolean;
  bot?: boolean;
  timezone?: string;
}

export interface InboundMessage {
  messageId: string;
  kind: ConversationKind;
  container: string;
  containerName?: string;
  thread?: string;
  author: SurfaceUser;
  members?: SurfaceUser[];
  text: string;
  mentionsSelf: boolean;
  threadEngaged: boolean;
}

interface SurfaceTarget {
  container: string;
  thread?: string;
}

interface OutboundMessage {
  text: string;
  idempotencyKey: string;
}

export type InboundOutcome =
  { status: 401; reason: string } | { status: 400; reason: string } | { status: 200; messages: InboundMessage[] };

export interface ChatSurfaceAdapter {
  readonly surface: string;
  readonly account: string;
  readonly label: string;
  receive(request: { headers: IncomingHttpHeaders; pathWithQuery: string; rawBody: string }): Promise<InboundOutcome>;
  post(target: SurfaceTarget, message: OutboundMessage): Promise<{ messageId: string }>;
}
