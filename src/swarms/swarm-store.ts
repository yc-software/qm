import type { DurableMap } from "../persistence/durable-map.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";

export const SWARM_LIMITS = {
  agents: 32,
  depth: 4,
  messages: 128,
  notifications: 256,
  spawnRequests: 32,
  contextBytes: 8_192,
  textBytes: 8_192,
  waitMs: 10_000,
  turnMs: 120_000,
  lifetimeMs: 60 * 60_000,
  sweepBatch: 16,
  sweepConcurrency: 4,
  reconcileMs: 30_000,
  provisionMs: 10_000,
} as const;

export interface SwarmMember {
  id: string;
  sessionId?: string;
  sessionUrl?: string;
  threadRef: string;
  parentId?: string;
  depth: number;
  context: unknown;
  sandboxId?: string;
  forumSandboxId?: string;
  state: "reserved" | "ready" | "failed";
  attempts: number;
  cleanupPending?: boolean;
  error?: string;
}

export interface SwarmMessage {
  id: string;
  seq: number;
  senderId: string;
  senderSessionId: string;
  author: "agent" | "human";
  actorId: string;
  text: string;
  audience: string[];
  replyTo?: string;
  createdAt: number;
  notifications: Record<string, { state: "pending" | "queued" | "failed"; runId?: string }>;
}

export interface Swarm {
  id: string;
  scopeId: string;
  ownerId: string;
  participants: string[];
  createdAt: number;
  expiresAt: number;
  template: OrchestratorInput;
  members: SwarmMember[];
  messages: SwarmMessage[];
  spawnRequests: Record<string, { memberIds: string[]; signature: string }>;
  messageRequests: Record<string, { messageId: string; signature: string }>;
  notificationCount: number;
  pending: boolean;
}

export interface SwarmStore {
  get(id: string): Promise<Swarm | null>;
  create(swarm: Swarm): Promise<Swarm>;
  update(id: string, mutate: (swarm: Swarm) => void): Promise<Swarm>;
  pending(afterId?: string): Promise<Swarm[]>;
}

export interface SwarmStorage extends Omit<Swarm, "members" | "messages"> {
  members: Array<Omit<SwarmMember, "context"> & { contextJson: string }>;
  messages: Array<Omit<SwarmMessage, "text"> & { textJson: string }>;
}

function encode(swarm: Swarm): SwarmStorage {
  return structuredClone({
    ...swarm,
    members: swarm.members.map(({ context, ...member }) => ({ ...member, contextJson: JSON.stringify(context) })),
    messages: swarm.messages.map(({ text, ...message }) => ({ ...message, textJson: JSON.stringify(text) })),
  });
}

function decode(swarm: SwarmStorage): Swarm {
  return structuredClone({
    ...swarm,
    members: swarm.members.map(({ contextJson, ...member }) => ({
      ...member,
      context: JSON.parse(contextJson) as unknown,
    })),
    messages: swarm.messages.map(({ textJson, ...message }) => ({ ...message, text: JSON.parse(textJson) as string })),
  });
}

export function createSwarmStore(backing: DurableMap<SwarmStorage>): SwarmStore {
  if (!backing.update) throw new Error("swarm storage requires atomic updates");
  return {
    async get(id) {
      const row = await backing.get(id);
      return row ? decode(row) : null;
    },
    create: async (swarm) => decode(await backing.putIfAbsent(swarm.id, encode(swarm))),
    async update(id, mutate) {
      const updated = await backing.update!(id, (value) => {
        const next = decode(value);
        mutate(next);
        next.pending =
          next.members.some((member) => member.state === "reserved" || member.cleanupPending) ||
          next.messages.some((message) =>
            Object.values(message.notifications).some((item) => item.state === "pending"),
          );
        return encode(next);
      });
      if (!updated) throw new Error("swarm not found");
      return decode(updated);
    },
    async pending(afterId) {
      return (
        await backing.select({
          where: { field: "pending", anyOfFold: ["true"] },
          limit: SWARM_LIMITS.sweepBatch,
          afterId,
        })
      ).map(decode);
    },
  };
}
