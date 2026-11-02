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

export interface Surface<Native = unknown> {
  readonly kind: string;
  post(ref: SurfaceRef, message: OutboundMessage, idempotencyKey: string): Promise<void>;
  principalFor(user: SurfaceUser): ActorAssertion;
  mention(user: SurfaceUser): string;
  readableText(text: string, mentions: Readonly<Record<string, string>> | undefined): string;
  native(kind: string): Native | null;
}
