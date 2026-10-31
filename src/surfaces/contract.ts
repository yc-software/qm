import type { IncomingHttpHeaders } from "node:http";
import type { SlackIdentityMode, SlackUser } from "../slack/identity.ts";
import type { ActorAssertion, ConversationKind, DeliveryProvenance, OutgoingAttachment } from "../types.ts";

export interface SurfaceRef {
  surface: string;
  account: string;
  kind: ConversationKind;
  container: string;
  thread?: string;
}

interface SurfaceUser {
  surface: string;
  account: string;
  id: string;
  email?: string;
  displayName?: string;
  bot?: boolean;
  guest?: boolean;
  timezone?: string;
}

interface SurfaceOrigin {
  ref: SurfaceRef;
  author: SurfaceUser;
  messageId: string;
  mentionsSelf: boolean;
  audience: "internal" | "external";
}

interface SurfaceCapabilities {
  threads: boolean;
  edits: boolean;
  reactions: "rw" | "read" | "none";
  privateReply: boolean;
  cards: boolean;
  history: boolean;
  format: "mrkdwn" | "markdown" | "plain";
  maxChars: number;
}

interface InboundMessage {
  origin: SurfaceOrigin;
  text: string;
  attachments: { id: string; name?: string; mimetype?: string; url?: string }[];
}

interface SurfaceRequest {
  headers: IncomingHttpHeaders;
  pathWithQuery: string;
  rawBody: string;
}

type InboundOutcome =
  { status: 401; reason: string } | { status: 400; reason: string } | { status: 200; messages: InboundMessage[] };

interface OutboundMessage {
  text: string;
  attachments?: OutgoingAttachment[];
  provenance?: DeliveryProvenance;
}

interface MessageRef {
  ref: SurfaceRef;
  messageId: string;
}

export interface SlackNative {
  accounts: Map<string, { ownTeamId: string; identityMode: SlackIdentityMode }>;
  userFrom(user: SlackUser | undefined, account: string): SurfaceUser;
}

interface SurfaceNatives {
  slack: SlackNative;
}

export interface Surface {
  readonly kind: string;
  readonly label: string;
  readonly capabilities: SurfaceCapabilities;
  normalize?(request: SurfaceRequest): Promise<InboundOutcome>;
  post(ref: SurfaceRef, message: OutboundMessage, idempotencyKey: string): Promise<MessageRef | void>;
  edit?(message: MessageRef, next: OutboundMessage, idempotencyKey: string): Promise<void>;
  react?(message: MessageRef, emoji: string, idempotencyKey: string): Promise<void>;
  followUpPrivately?(ref: SurfaceRef, user: SurfaceUser, message: OutboundMessage): Promise<MessageRef | void>;
  principalFor(user: SurfaceUser): ActorAssertion;
  mention(user: SurfaceUser): string;
  promptHints(): { surfaceLabel: string; mentionSyntax?: string };
  native<K extends keyof SurfaceNatives>(kind: K): SurfaceNatives[K] | null;
}
