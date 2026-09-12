import { createKeyedQueue } from "../util/async.ts";
import type { Swarm, SwarmMember, SwarmReservation } from "./types.ts";
import { reservationRefusal, type ReserveResult, type SwarmStore } from "./swarm-store.ts";

export function createMemorySwarmStore(): SwarmStore {
  const swarms = new Map<string, Swarm>();
  const members = new Map<string, Map<string, SwarmMember>>();
  const reservations = new Map<string, Map<string, SwarmReservation>>();
  const serialize = createKeyedQueue<string>();

  const memberMap = (swarmId: string): Map<string, SwarmMember> => {
    const existing = members.get(swarmId);
    if (existing) return existing;
    const created = new Map<string, SwarmMember>();
    members.set(swarmId, created);
    return created;
  };
  const reservationMap = (swarmId: string): Map<string, SwarmReservation> => {
    const existing = reservations.get(swarmId);
    if (existing) return existing;
    const created = new Map<string, SwarmReservation>();
    reservations.set(swarmId, created);
    return created;
  };

  return {
    createSwarm(input) {
      return serialize(input.id, async () => {
        const swarm: Swarm = {
          id: input.id,
          scopeId: input.scopeId,
          rootSessionId: input.rootSessionId,
          sessionLimit: input.sessionLimit,
          maxChildrenPerParent: input.maxChildrenPerParent,
          maxDepth: input.maxDepth,
          sessionsUsed: 1,
          stoppedAt: null,
          createdAt: input.createdAt,
        };
        swarms.set(swarm.id, swarm);
        memberMap(swarm.id).set(input.rootSessionId, {
          swarmId: swarm.id,
          sessionId: input.rootSessionId,
          parentSessionId: null,
          depth: 0,
          childrenUsed: 0,
          stoppedAt: null,
          createdAt: input.createdAt,
        });
        return swarm;
      });
    },
    async getSwarm(swarmId) {
      return swarms.get(swarmId) ?? null;
    },
    async getMember(swarmId, sessionId) {
      return memberMap(swarmId).get(sessionId) ?? null;
    },
    async members(swarmId) {
      return [...memberMap(swarmId).values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    reserve(input) {
      return serialize(input.swarmId, async (): Promise<ReserveResult> => {
        const swarm = swarms.get(input.swarmId);
        if (!swarm) return { ok: false, reason: "unknown_swarm" };
        const existing = reservationMap(input.swarmId).get(input.requestId);
        if (existing)
          return { ok: true, reservation: { ...existing, sessionIds: [...existing.sessionIds] }, replay: true };
        const parent = memberMap(input.swarmId).get(input.parentSessionId) ?? null;
        const refusal = reservationRefusal(swarm, parent, input.n);
        if (refusal) return { ok: false, reason: refusal };
        swarms.set(swarm.id, { ...swarm, sessionsUsed: swarm.sessionsUsed + input.n });
        memberMap(input.swarmId).set(parent!.sessionId, { ...parent!, childrenUsed: parent!.childrenUsed + input.n });
        const reservation: SwarmReservation = {
          swarmId: input.swarmId,
          requestId: input.requestId,
          parentSessionId: input.parentSessionId,
          n: input.n,
          sessionIds: [],
          createdAt: input.createdAt,
        };
        reservationMap(input.swarmId).set(input.requestId, reservation);
        return { ok: true, reservation: { ...reservation, sessionIds: [] }, replay: false };
      });
    },
    async getReservation(swarmId, requestId) {
      const reservation = reservationMap(swarmId).get(requestId);
      return reservation ? { ...reservation, sessionIds: [...reservation.sessionIds] } : null;
    },
    appendChild(input) {
      return serialize(input.swarmId, async () => {
        memberMap(input.swarmId).set(input.childSessionId, {
          swarmId: input.swarmId,
          sessionId: input.childSessionId,
          parentSessionId: input.parentSessionId,
          depth: input.depth,
          childrenUsed: 0,
          stoppedAt: null,
          createdAt: input.createdAt,
        });
        const reservation = reservationMap(input.swarmId).get(input.requestId);
        if (reservation && !reservation.sessionIds.includes(input.childSessionId)) {
          reservationMap(input.swarmId).set(input.requestId, {
            ...reservation,
            sessionIds: [...reservation.sessionIds, input.childSessionId],
          });
        }
      });
    },
    settleFailure(swarmId, requestId, discardedSessionIds) {
      return serialize(swarmId, async () => {
        const reservation = reservationMap(swarmId).get(requestId);
        if (!reservation) return;
        for (const sessionId of discardedSessionIds) memberMap(swarmId).delete(sessionId);
        const kept = reservation.sessionIds.filter((id) => !discardedSessionIds.includes(id));
        if (kept.length) {
          reservationMap(swarmId).set(requestId, { ...reservation, sessionIds: kept });
          return;
        }
        const swarm = swarms.get(swarmId);
        if (swarm) swarms.set(swarmId, { ...swarm, sessionsUsed: swarm.sessionsUsed - reservation.n });
        const parent = memberMap(swarmId).get(reservation.parentSessionId);
        if (parent) {
          memberMap(swarmId).set(parent.sessionId, { ...parent, childrenUsed: parent.childrenUsed - reservation.n });
        }
        reservationMap(swarmId).delete(requestId);
      });
    },
    markStopped(swarmId, sessionIds, at, wholeSwarm) {
      return serialize(swarmId, async () => {
        for (const sessionId of sessionIds) {
          const member = memberMap(swarmId).get(sessionId);
          if (member && member.stoppedAt === null) memberMap(swarmId).set(sessionId, { ...member, stoppedAt: at });
        }
        const swarm = swarms.get(swarmId);
        if (wholeSwarm && swarm && swarm.stoppedAt === null) swarms.set(swarmId, { ...swarm, stoppedAt: at });
      });
    },
  };
}
