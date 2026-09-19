import { ABSURD_MIGRATION } from "../durable/schema.ts";
import { SWARM_WORKFLOW_MIGRATION } from "./postgres-swarm-workflow.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";
import type { RunStore, Run } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { assertSwarmRun, type SwarmRunFence } from "./swarm-fence.ts";
import { jsonbStringify, type DurableMap } from "../persistence/durable-map.ts";
import type { OrchestratorInput } from "../core/orchestrator.ts";

import type { SwarmSettings } from "./swarm-settings.ts";
import type { SandboxBackendName } from "../sandbox/sandbox-routing.ts";

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
  settings: SwarmSettings;
  backend: SandboxBackendName;
  members: SwarmMember[];
  messages: SwarmMessage[];
  spawnRequests: Record<string, { memberIds: string[]; signature: string }>;
  messageRequests: Record<string, { messageId: string; signature: string }>;
  notificationCount: number;
  pending: boolean;
}

export function assertSwarmOpen(swarm: Swarm): void {
  if (Date.now() >= swarm.expiresAt) throw new NonRetryableTurnError("swarm work window expired");
}

export interface SwarmStore {
  get(id: string): Promise<Swarm | null>;
  create(swarm: Swarm, fence?: SwarmRunFence): Promise<Swarm>;
  update(id: string, mutate: (swarm: Swarm) => void, fence?: SwarmRunFence): Promise<Swarm>;
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

export function createSwarmStore(
  backing: DurableMap<SwarmStorage>,
  authority?: { runs: Pick<RunStore, "get">; sessions: Pick<SessionStore, "get">; pg?: PgPool },
): SwarmStore {
  if (!backing.update) throw new Error("swarm storage requires atomic updates");
  authority?.pg?.registerMigration(ABSURD_MIGRATION);
  authority?.pg?.registerMigration(SWARM_WORKFLOW_MIGRATION);
  let initialized: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (!authority?.pg) return Promise.resolve();
    return (initialized ??= (async () => {
      await backing.get("");
      await authority.pg!.migrate(ABSURD_MIGRATION);
      await authority.pg!.migrate(SWARM_WORKFLOW_MIGRATION);
    })().catch((error) => {
      initialized = undefined;
      throw error;
    }));
  };
  async function fencedWrite(
    id: string,
    mutate: (value: SwarmStorage | null) => SwarmStorage,
    fence: SwarmRunFence,
  ): Promise<SwarmStorage> {
    if (!authority) throw new Error("swarm run validation unavailable");
    const pg = authority.pg;
    if (pg) {
      await backing.get(id);
      return withPgTransaction(await pg.pool(), async (client) => {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        const result = await client.query<Run>(
          `SELECT status, attempts, lease_token AS "leaseToken", lease_expires_at::double precision AS "leaseExpiresAt", session_id AS "sessionId", request::jsonb AS request FROM runs WHERE id=$1 FOR UPDATE`,
          [fence.runId],
        );
        const run = result.rows[0] ?? null;
        assertSwarmRun(fence, run);
        const session = await client.query(
          "SELECT id FROM sessions WHERE id=$1 AND scope_id=$2 AND thread_ref=$3 FOR SHARE",
          [fence.sessionId, fence.scopeId, fence.threadRef],
        );
        if (!session.rowCount) throw new Error("capability session mismatch");
        await client.query(
          "INSERT INTO durable_map_versions (tbl,v) VALUES ('swarms',1) ON CONFLICT (tbl) DO UPDATE SET v=durable_map_versions.v+1",
        );
        const current = await client.query<{ json: SwarmStorage }>("SELECT json FROM swarms WHERE id=$1 FOR UPDATE", [
          id,
        ]);
        const next = mutate(current.rows[0]?.json ?? null);
        await client.query(
          "INSERT INTO swarms (id,json) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET json=EXCLUDED.json",
          [id, jsonbStringify(next)],
        );
        assertSwarmRun(fence, run);
        return next;
      });
    }
    const session = await authority.sessions.get(fence.sessionId);
    if (!session || session.scopeId !== fence.scopeId || session.threadRef !== fence.threadRef)
      throw new Error("capability session mismatch");
    const run = await authority.runs.get(fence.runId);
    assertSwarmRun(fence, run);
    const updated = await backing.update!(id, (current) => {
      assertSwarmRun(fence, run);
      return mutate(current);
    });
    if (updated) return updated;
    assertSwarmRun(fence, run);
    return backing.putIfAbsent(id, mutate(null));
  }
  return {
    async get(id) {
      await ready();
      const row = await backing.get(id);
      return row ? decode(row) : null;
    },
    async create(swarm, fence) {
      await ready();
      const create = (current: SwarmStorage | null) => {
        if (current) return current;
        assertSwarmOpen(swarm);
        return encode(swarm);
      };
      if (fence) return decode(await fencedWrite(swarm.id, create, fence));
      return decode(await backing.putIfAbsent(swarm.id, create(null)));
    },
    async update(id, mutate, fence) {
      await ready();
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
      const updated = fence ? await fencedWrite(id, apply, fence) : await backing.update!(id, apply);
      if (!updated) throw new Error("swarm not found");
      return decode(updated);
    },
    async pending(afterId) {
      await ready();
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
