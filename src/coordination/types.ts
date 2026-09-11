import type { Conversation, Principal, ScopeId } from "../types.ts";

export type Character = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | Character;

export interface PeerAuthority {
  actor: Principal;
  conversation: Conversation;
  surface: string;
  scopeVersion?: string;
}

export interface Peer {
  id: string;
  name: string;
  character: Character;
  version: number;
  scopeId: ScopeId;
  parentId: string | null;
  rootId: string;
  ancestors: string[];
  descendantLimit: number;
  state: "active" | "paused" | "stopped" | "archived" | "deleted";
  authority: PeerAuthority | null;
  sandboxId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type PublicPeer = Pick<
  Peer,
  | "id"
  | "name"
  | "character"
  | "version"
  | "parentId"
  | "rootId"
  | "descendantLimit"
  | "state"
  | "createdAt"
  | "updatedAt"
>;

export interface AudienceCandidate {
  id: string;
  version: number;
  name: string;
  character: Character;
}

export interface PeerMessage {
  id: string;
  senderId: string;
  senderRunId: string;
  senderName: string;
  text: string;
  audience: string;
  candidates: AudienceCandidate[];
  recipientIds: string[];
  replyTo: string | null;
  threadId: string;
  createdAt: number;
  sequence: number;
}

export interface PeerDelivery {
  id: string;
  messageId: string;
  recipientId: string;
  state: "queued" | "delivered" | "blocked" | "failed";
  attempts: number;
  runId: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  leaseToken: string | null;
  leaseUntil: number;
}

export interface PeerSpawn {
  id: string;
  parentId: string;
  parentRunId: string;
  backend: import("../sandbox/sandbox-routing.ts").SandboxBackendName;
  childId: string;
  rootId: string;
  task: string;
  initialName: string;
  initialCharacter: Character;
  leaseToken: string | null;
  leaseUntil: number;
  attempts: number;
  state: "reserved" | "provisioning" | "ready" | "failed";
  sandboxId: string | null;
  runId: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type PublicSpawn = Pick<PeerSpawn, "id" | "state" | "attempts" | "createdAt" | "updatedAt" | "reason">;

export function publicSpawn(spawn: PeerSpawn): PublicSpawn {
  const reasons = new Set([
    "spawn_parent_unavailable",
    "spawn_child_unavailable",
    "execution_authority_revoked",
    "spawn_scope_changed",
    "spawn_dispatch_pending",
    "spawn_provisioning_failed",
    "spawn_lease_lost",
  ]);
  return {
    id: spawn.id,
    state: spawn.state,
    attempts: spawn.attempts,
    createdAt: spawn.createdAt,
    updatedAt: spawn.updatedAt,
    reason: spawn.reason && (reasons.has(spawn.reason) ? spawn.reason : "spawn_provisioning_failed"),
  };
}

export interface CoordinationRows {
  peer: Peer;
  message: PeerMessage;
  delivery: PeerDelivery;
  spawn: PeerSpawn;
}

export type CoordinationKind = keyof CoordinationRows;

export interface CoordinationEvent {
  sequence: number;
  kind: CoordinationKind;
  id: string;
  at: number;
}

export class CoordinationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function publicPeer(peer: Peer): PublicPeer {
  const { id, name, character, version, parentId, rootId, descendantLimit, state, createdAt, updatedAt } = peer;
  return structuredClone({
    id,
    name,
    character,
    version,
    parentId,
    rootId,
    descendantLimit,
    state,
    createdAt,
    updatedAt,
  });
}
