import type { ActorAssertion, ConversationKind, DeliveryProvenance, OutgoingAttachment } from "../types.ts";

interface SurfaceRef {
  surface: string;
  account: string;
  workspace?: string;
  policyNamespace?: string;
  kind: ConversationKind;
  container: string;
  thread?: string;
}

export interface SurfaceUser {
  surface: string;
  account: string;
  id: string;
  principal: ActorAssertion;
  timezone?: string;
}

interface OutboundMessage {
  text: string;
  attachments?: OutgoingAttachment[];
  provenance: DeliveryProvenance;
}

interface SurfaceCapabilities {
  threads: boolean;
  mirrored: boolean;
  firstBlockAck: boolean;
  replyEngagement: boolean;
  actingUser: boolean;
  externalParticipants: boolean;
  rateLimitNotice: boolean;
}

interface SurfacePromptHints {
  mentionSyntax: string;
  linkSyntax: string;
  autonomousStyle: string;
  conversationStyle: string;
}

export interface Surface<Native = unknown> {
  readonly kind: string;
  readonly label: string;
  readonly capabilities: SurfaceCapabilities;
  promptHints(): SurfacePromptHints;
  post(ref: SurfaceRef, message: OutboundMessage, idempotencyKey: string): Promise<void>;
  principalFor(user: SurfaceUser): ActorAssertion;
  mention(user: SurfaceUser): string;
  native(kind: string): Native | null;
}
