import type { ActorAssertion, ConversationKind, DeliveryProvenance, OutgoingAttachment } from "../types.ts";

export interface SurfaceRef {
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

export interface SurfaceNatives {
  [kind: string]: unknown;
}

export interface Surface {
  readonly kind: string;
  post(ref: SurfaceRef, message: OutboundMessage, idempotencyKey: string): Promise<void>;
  principalFor(user: SurfaceUser): ActorAssertion;
  mention(user: SurfaceUser): string;
  native<K extends keyof SurfaceNatives>(kind: K): SurfaceNatives[K] | null;
}
