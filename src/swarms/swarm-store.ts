import type { GoalCreateInput } from "../agent/goal.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import type { SwarmRunFence } from "./swarm-fence.ts";
import type { SwarmRows } from "./swarm-table.ts";

import type { SwarmSettings } from "./swarm-settings.ts";
import type { SandboxBackendName } from "../sandbox/sandbox-routing.ts";
import type { SwarmMemberRuntime, SwarmTemplate } from "./swarm-runtime.ts";

export const SWARM_LIMITS = {
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
  runtime?: SwarmMemberRuntime;
  sandboxId?: string;
  forumSandboxId?: string;
  state: "reserved" | "ready" | "failed";
  control?: "paused" | "stopped";
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
  goal?: GoalCreateInput;
  createdAt: number;
  notifications: Record<string, { state: "pending" | "mailbox" | "queued" | "handed" | "failed"; runId?: string }>;
}

export interface Swarm {
  id: string;
  scopeId: string;
  ownerId: string;
  participants: string[];
  createdAt: number;
  expiresAt?: number;
  template: SwarmTemplate;
  settings: SwarmSettings;
  backend: SandboxBackendName;
  board?: { sandboxId: string };
  members: SwarmMember[];
  messages: SwarmMessage[];
  spawnRequests: Record<string, { memberIds: string[]; signature: string }>;
  messageRequests: Record<string, { messageId: string; signature: string }>;
  notificationCount: number;
  pending: boolean;
}

export function swarmExpired(swarm: Swarm): boolean {
  return swarm.expiresAt !== undefined && Date.now() >= swarm.expiresAt;
}

export function assertSwarmOpen(swarm: Swarm): void {
  if (swarmExpired(swarm)) throw new NonRetryableTurnError("swarm work window expired");
}

export interface SwarmStore {
  get(id: string): Promise<Swarm | null>;
  create(swarm: Swarm, fence?: SwarmRunFence): Promise<Swarm>;
  update(id: string, mutate: (swarm: Swarm) => void, fence?: SwarmRunFence): Promise<Swarm>;
  pending(afterId?: string): Promise<Array<Swarm & { tenantId: string }>>;
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

export function createSwarmStore(rows: SwarmRows): SwarmStore {
  return {
    async get(id) {
      const row = await rows.get(id);
      return row ? decode(row) : null;
    },
    async create(swarm, fence) {
      const create = (current: SwarmStorage | null) => {
        if (current) return current;
        assertSwarmOpen(swarm);
        return encode(swarm);
      };
      return decode(await rows.write(swarm.id, create, fence));
    },
    async update(id, mutate, fence) {
      const apply = (value: SwarmStorage | null) => {
        if (!value) throw new Error("swarm not found");
        const next = decode(value);
        mutate(next);
        next.pending =
          next.members.some((member) => member.state === "reserved" || member.cleanupPending) ||
          next.messages.some((message) =>
            Object.values(message.notifications).some((item) => item.state === "pending"),
          );
        return encode(next);
      };
      return decode(await rows.write(id, apply, fence));
    },
    async pending(afterId) {
      const batch = await rows.pending(afterId, SWARM_LIMITS.sweepBatch);
      return batch.map(({ tenantId, ...row }) => ({ ...decode(row), tenantId }));
    },
  };
}
