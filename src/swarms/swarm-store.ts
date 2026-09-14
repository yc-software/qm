import type { SwarmPublicIdentity } from "./swarm-board-view.ts";
export type { SwarmPublicIdentity } from "./swarm-board-view.ts";
import type { SwarmControl } from "./swarm-control.ts";
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
  discoveryBatch: 32,
  discoveryScan: 512,
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
  publicIdentity?: SwarmPublicIdentity;
  control?: SwarmControl;
  descendantLimit?: number;
  sandboxId?: string;
  forumSandboxId?: string;
  state: "reserved" | "ready" | "failed";
  attempts: number;
  cleanupPending?: boolean;
  error?: string;
}

interface SwarmPublication {
  sender: SwarmPublicIdentity;
  audience: SwarmPublicIdentity[];
  destinations: Record<string, { swarmId: string; memberId: string }>;
}

export interface SwarmPublicMessage {
  id: string;
  visibility: "org";
  sender: SwarmPublicIdentity;
  audience: SwarmPublicIdentity[];
  author: "agent" | "human";
  text: string;
  replyTo?: string;
  createdAt: number;
  notifications: Record<string, { state: "pending" | "queued" | "failed" }>;
}

export function publicMessageCursor(message: Pick<SwarmMessage, "id" | "createdAt">): string {
  return `${String(message.createdAt).padStart(16, "0")}:${message.id}`;
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
  publication?: SwarmPublication;
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
  receivedRequests?: Record<string, true>;
  pending: boolean;
  controlsPending?: boolean;
}

export function assertSwarmOpen(swarm: Swarm): void {
  if (Date.now() >= swarm.expiresAt) throw new NonRetryableTurnError("swarm work window expired");
}

export interface SwarmStore {
  get(id: string): Promise<Swarm | null>;
  create(swarm: Swarm, fence?: SwarmRunFence): Promise<Swarm>;
  update(id: string, mutate: (swarm: Swarm) => void, fence?: SwarmRunFence): Promise<Swarm>;
  pending(afterId?: string): Promise<Swarm[]>;
  published(
    afterId?: string,
    ids?: string[],
  ): Promise<Array<{ swarmId: string; memberId: string; identity: SwarmPublicIdentity }>>;
  publicMessages(options: { after?: string; id?: string }): Promise<Array<{ swarmId: string; message: SwarmMessage }>>;
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
      const row = await backing.get(id);
      return row ? decode(row) : null;
    },
    async create(swarm, fence) {
      const create = (current: SwarmStorage | null) => {
        if (current) return current;
        assertSwarmOpen(swarm);
        return encode(swarm);
      };
      if (fence) return decode(await fencedWrite(swarm.id, create, fence));
      return decode(await backing.putIfAbsent(swarm.id, create(null)));
    },
    async update(id, mutate, fence) {
      const apply = (value: SwarmStorage | null) => {
        if (!value) throw new Error("swarm not found");
        const next = decode(value);
        mutate(next);
        next.pending =
          Boolean(next.controlsPending) ||
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
    async published(afterId = "", ids) {
      if (ids?.length === 0) return [];
      if (authority?.pg) {
        await backing.select({ limit: 0 });
        const result = await (
          await authority.pg.pool()
        ).query<{ swarmId: string; memberId: string; identity: SwarmPublicIdentity }>(
          `SELECT swarms.id AS "swarmId", member->>'id' AS "memberId", member->'publicIdentity' AS identity FROM swarms CROSS JOIN LATERAL jsonb_array_elements(json->'members') member WHERE member->'publicIdentity'->>'id' COLLATE "C" > $1 AND ($3::text[] IS NULL OR member->'publicIdentity'->>'id' = ANY($3)) ORDER BY member->'publicIdentity'->>'id' COLLATE "C" LIMIT $2`,
          [afterId, ids?.length ?? SWARM_LIMITS.discoveryBatch, ids ?? null],
        );
        return result.rows;
      }
      const swarms = await backing.select({ omit: ["messages", "template", "spawnRequests", "messageRequests"] });
      return swarms
        .flatMap((swarm) =>
          swarm.members.flatMap((member) =>
            member.publicIdentity &&
            member.publicIdentity.id > afterId &&
            (!ids || ids.includes(member.publicIdentity.id))
              ? [{ swarmId: swarm.id, memberId: member.id, identity: structuredClone(member.publicIdentity) }]
              : [],
          ),
        )
        .sort((left, right) => {
          if (left.identity.id < right.identity.id) return -1;
          if (left.identity.id > right.identity.id) return 1;
          return 0;
        })
        .slice(0, ids?.length ?? SWARM_LIMITS.discoveryBatch);
    },
    async publicMessages(options) {
      if (authority?.pg) {
        await backing.select({ limit: 0 });
        const result = await (
          await authority.pg.pool()
        ).query<{
          swarmId: string;
          message: SwarmStorage["messages"][number];
        }>(
          `SELECT swarms.id AS "swarmId", message FROM swarms
           CROSS JOIN LATERAL jsonb_array_elements(json->'messages') message
           WHERE message->'publication' IS NOT NULL
             AND ($1::text IS NULL OR message->>'id' = $1)
             AND ($2::text IS NULL OR (lpad(message->>'createdAt',16,'0') || ':' || (message->>'id')) COLLATE "C" < $2)
           ORDER BY (lpad(message->>'createdAt',16,'0') || ':' || (message->>'id')) COLLATE "C" DESC LIMIT $3`,
          [options.id ?? null, options.after ?? null, SWARM_LIMITS.discoveryBatch],
        );
        return result.rows.map(({ swarmId, message: { textJson, ...message } }) => ({
          swarmId,
          message: { ...message, text: JSON.parse(textJson) as string },
        }));
      }
      const swarms = await backing.select({ omit: ["members", "template", "spawnRequests", "messageRequests"] });
      return swarms
        .flatMap((swarm) =>
          swarm.messages.flatMap(({ textJson, ...message }) => {
            if (
              !message.publication ||
              (options.id && message.id !== options.id) ||
              (options.after && publicMessageCursor(message) >= options.after)
            )
              return [];
            return [{ swarmId: swarm.id, message: { ...message, text: JSON.parse(textJson) as string } }];
          }),
        )
        .sort((a, b) => publicMessageCursor(b.message).localeCompare(publicMessageCursor(a.message)))
        .slice(0, SWARM_LIMITS.discoveryBatch);
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
