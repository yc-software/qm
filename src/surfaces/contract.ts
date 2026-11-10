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

export interface SurfaceAccount {
  id: string;
  workspace?: string;
  policyNamespace?: string;
}

export interface ExternalAudienceAccess {
  companyDomains: string[];
  companyTeamIds: string[];
  serviceCredentials: string[];
}

export type TurnSurfaceOrigin = {
  author: Pick<SurfaceUser, "surface" | "account" | "id">;
  workspace: string;
  policyNamespace?: string;
  replyThread?: string;
} & ({ audience: "internal" } | { audience: "external"; access: ExternalAudienceAccess });

interface OutboundMessage {
  text: string;
  attachments?: OutgoingAttachment[];
  provenance: DeliveryProvenance;
}

interface SurfaceCapabilities {
  mirrored: boolean;
  liveReplies: boolean;
  nativeActor: boolean;
  externalParticipants: boolean;
  textOnly: boolean;
}

export interface SurfacePromptHints {
  mentionSyntax: string;
  linkSyntax: string;
  autonomousStyle: string;
  conversationStyle: string;
}

export interface Surface<Native = unknown> {
  readonly kind: string;
  readonly label: string;
  readonly capabilities: SurfaceCapabilities;
  readonly promptHints: SurfacePromptHints;
  post(ref: SurfaceRef, message: OutboundMessage, idempotencyKey: string): Promise<void>;
  threadTarget?(target: string, threadTs: string): Promise<string>;
  containerOf(target: string): string;
  principalFor(user: SurfaceUser): ActorAssertion;
  mention(user: SurfaceUser): string;
  native(kind: string): Native | null;
}
