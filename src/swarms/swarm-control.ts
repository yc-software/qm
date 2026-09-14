import type { Swarm, SwarmMember } from "./swarm-store.ts";

export type SwarmControlState = "active" | "paused" | "stopped";
export interface SwarmControl {
  state: SwarmControlState;
  version: number;
  updatedAt: number;
}

export function lineage(swarm: Swarm, memberId: string): SwarmMember[] {
  const ancestors: SwarmMember[] = [];
  let id: string | undefined = memberId;
  while (id) {
    const member = swarm.members.find((peer) => peer.id === id);
    if (!member || ancestors.includes(member)) throw new Error("invalid swarm ancestry");
    ancestors.push(member);
    id = member.parentId;
  }
  return ancestors;
}

export function controlState(swarm: Swarm, memberId: string): SwarmControlState {
  const ancestors = lineage(swarm, memberId);
  if (ancestors.some((member) => member.control?.state === "stopped")) return "stopped";
  if (ancestors.some((member) => member.control?.state === "paused")) return "paused";
  return "active";
}
