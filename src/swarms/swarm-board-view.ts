export interface SwarmPublicIdentity {
  id: string;
  name: string;
  version: number;
  character: Record<string, unknown>;
  updatedAt: number;
}

export interface SwarmBoardQuery {
  visibility: "private" | "org";
  after?: string;
  id?: string;
  replyTo?: string;
  sender?: string;
  recipient?: string;
  search?: string;
  limit?: number;
}

interface SwarmBoardPerson {
  id: string;
  name: string;
  version?: number;
  character?: Record<string, unknown>;
}

export interface SwarmBoardMessage {
  id: string;
  visibility: "private" | "org";
  sender: SwarmBoardPerson;
  audience: SwarmBoardPerson[];
  text: string;
  replyTo?: string;
  createdAt: number;
  author: "agent" | "human";
  notifications: Record<string, { state: "pending" | "queued" | "failed" }>;
}

export interface SwarmBoardMember {
  id: string;
  name: string;
  parentId?: string;
  depth: number;
  descendants: number;
  descendantLimit: number;
  state: "reserved" | "ready" | "failed";
  attempts: number;
  cleanupPending: boolean;
  control: "active" | "paused" | "stopped";
  controlVersion: number;
  effectiveState: "active" | "paused" | "stopped";
  sessionId?: string;
  publicIdentity?: SwarmPublicIdentity;
}

export interface SwarmBoardDelivery {
  recipientId: string;
  dispatch: "pending" | "queued" | "failed";
  /** Explicit reply evidence within the returned replies page, not global completion. */
  answered: boolean;
  execution?: "queued" | "paused" | "running" | "completed" | "stopped" | "failed" | "refused" | "waiting_approval";
  runId?: string;
  sessionId?: string;
}

export interface SwarmBoardPage {
  visibility: "private" | "org";
  selfId: string;
  writable: boolean;
  canManage: boolean;
  expiresAt?: number;
  members: SwarmBoardMember[];
  messages: SwarmBoardMessage[];
  nextAfter?: string;
  deliveries?: SwarmBoardDelivery[];
  replies?: SwarmBoardMessage[];
  repliesNextAfter?: string;
}

export interface SwarmTranscriptLabel {
  swarmId: string;
  messageId: string;
  recipientId: string;
  visibility: "private" | "org";
  senderName: string;
}
