import type { ScopeId } from "../types.ts";

export const PEER_COORDINATION_FLAG = "peer_coordination" as const;

export const MAX_AGENT_NAME_CHARS = 80;
export const MAX_CHARACTER_BYTES = 16_384;
export const MAX_MESSAGE_TEXT_CHARS = 32_000;
export const MAX_AUDIENCE_EXPR_CHARS = 2_000;
export const MAX_AUDIENCE_RECIPIENTS = 256;
export const MAX_BOARD_PAGE = 200;

export const DEFAULT_SESSION_LIMIT = 16;
export const DEFAULT_MAX_CHILDREN_PER_PARENT = 4;
export const DEFAULT_MAX_DEPTH = 3;
export const PROVISIONING_LEASE_MS = 60_000;

export interface PeerIdentity {
  sessionId: string;
  orgId: string;
  scopeId: ScopeId;
  agentName: string;
  character: Record<string, unknown>;
  characterVersion: number;
  parentSessionId: string | null;
  swarmId: string | null;
  depth: number;
  executionActorId: string;
  createdAt: number;
  updatedAt: number;
}

type PeerLifecycle = "active" | "stopped";

export interface PeerView {
  sessionId: string;
  agentName: string;
  character: Record<string, unknown>;
  characterVersion: number;
  parentSessionId: string | null;
  swarmId: string | null;
  depth: number;
  lifecycle: PeerLifecycle;
}

export interface PeerMessage {
  id: string;
  seq: number;
  orgId: string;
  senderSessionId: string;
  senderRunId: string | null;
  text: string;
  audienceExpr: string | null;
  resolvedRecipientIds: string[];
  replyTo: string | null;
  createdAt: number;
}

export interface PeerDelivery {
  messageId: string;
  recipientSessionId: string;
  runId: string | null;
  dispatchedAt: number | null;
  consumedAt: number | null;
  attempts: number;
  nextAttemptAt: number | null;
  lastStatus: string | null;
  lastReason: string | null;
}

export interface Swarm {
  id: string;
  scopeId: ScopeId;
  rootSessionId: string;
  sessionLimit: number;
  maxChildrenPerParent: number;
  maxDepth: number;
  sessionsUsed: number;
  stoppedAt: number | null;
  createdAt: number;
}

export interface SwarmMember {
  swarmId: string;
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  childrenUsed: number;
  stoppedAt: number | null;
  createdAt: number;
}

export interface SwarmReservation {
  swarmId: string;
  requestId: string;
  parentSessionId: string;
  n: number;
  slots: (string | null)[];
  leaseExpiresAt: number;
  createdAt: number;
}
