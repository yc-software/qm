import type { ScopeId } from "../types.ts";
import type { Swarm, SwarmMember, SwarmReservation } from "./types.ts";

interface CreateSwarmInput {
  id: string;
  scopeId: ScopeId;
  rootSessionId: string;
  sessionLimit: number;
  maxChildrenPerParent: number;
  maxDepth: number;
  createdAt: number;
}

interface ReserveInput {
  swarmId: string;
  requestId: string;
  parentSessionId: string;
  n: number;
  createdAt: number;
}

export type ReserveRefusal =
  | "unknown_swarm"
  | "swarm_stopped"
  | "unknown_parent"
  | "parent_stopped"
  | "pool_exhausted"
  | "breadth_exceeded"
  | "depth_exceeded"
  | "provisioning_in_progress";

export type ReserveResult =
  { ok: true; reservation: SwarmReservation; replay: boolean } | { ok: false; reason: ReserveRefusal };

interface AppendChildInput {
  swarmId: string;
  requestId: string;
  childSessionId: string;
  parentSessionId: string;
  slot: number;
  depth: number;
  createdAt: number;
}

export interface SwarmStore {
  createSwarm(input: CreateSwarmInput): Promise<Swarm>;
  getSwarm(swarmId: string): Promise<Swarm | null>;
  getMember(swarmId: string, sessionId: string): Promise<SwarmMember | null>;
  members(swarmId: string): Promise<SwarmMember[]>;
  reserve(input: ReserveInput): Promise<ReserveResult>;
  getReservation(swarmId: string, requestId: string): Promise<SwarmReservation | null>;
  appendChild(input: AppendChildInput): Promise<void>;
  settleFailure(swarmId: string, requestId: string, discardedSessionIds: readonly string[]): Promise<void>;
  markStopped(swarmId: string, sessionIds: readonly string[], at: number, wholeSwarm: boolean): Promise<void>;
  close?(): Promise<void>;
}

export function reservationBusy(reservation: SwarmReservation, at: number): boolean {
  return reservation.slots.includes(null) && reservation.leaseExpiresAt > at;
}

export function liveChildren(reservation: SwarmReservation): string[] {
  return reservation.slots.filter((id): id is string => id !== null);
}

export function reservationRefusal(
  swarm: Pick<Swarm, "stoppedAt" | "sessionsUsed" | "sessionLimit" | "maxChildrenPerParent" | "maxDepth">,
  parent: Pick<SwarmMember, "stoppedAt" | "childrenUsed" | "depth"> | null,
  n: number,
): ReserveRefusal | null {
  if (swarm.stoppedAt !== null) return "swarm_stopped";
  if (!parent) return "unknown_parent";
  if (parent.stoppedAt !== null) return "parent_stopped";
  if (swarm.sessionsUsed + n > swarm.sessionLimit) return "pool_exhausted";
  if (parent.childrenUsed + n > swarm.maxChildrenPerParent) return "breadth_exceeded";
  if (parent.depth + 1 > swarm.maxDepth) return "depth_exceeded";
  return null;
}

export function descendantSessionIds(members: readonly SwarmMember[], rootSessionId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const member of members) {
    if (member.parentSessionId === null) continue;
    childrenOf.set(member.parentSessionId, [...(childrenOf.get(member.parentSessionId) ?? []), member.sessionId]);
  }
  const out: string[] = [];
  const walk = (sessionId: string): void => {
    for (const child of childrenOf.get(sessionId) ?? []) {
      if (out.includes(child)) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(rootSessionId);
  return out;
}
