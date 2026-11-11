import type { GoalCreateInput } from "../agent/goal.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";
import type { RunStore, Run } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { assertSwarmRun, type SwarmRunFence } from "./swarm-fence.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { jsonbStringify } from "../util/text.ts";
import { claimThenBind } from "../tenants/claim.ts";
import { currentTenant } from "../tenants/context.ts";

import type { SwarmSettings } from "./swarm-settings.ts";
import type { SandboxBackendName } from "../sandbox/sandbox-routing.ts";
import type { SwarmMemberRuntime, SwarmTemplate } from "./swarm-runtime.ts";

export const SWARM_LIMITS = {
  sweepBatch: 16,
  sweepConcurrency: 4,
  reconcileMs: 30_000,
  pausedRecheckMs: 15_000,
  provisionMs: 10_000,
} as const;

export const STAMP_SWARM_COMPUTERS_MIGRATION = {
  id: "durable-map/swarms/0040-stamp-computers",
  statements: [
    `DO $$
    BEGIN
      IF to_regclass('swarms') IS NOT NULL AND to_regclass('sandbox_resources') IS NOT NULL THEN
        UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'sandbox_resources';
        UPDATE sandbox_resources r SET json = r.json || jsonb_build_object('swarmId', c.swarm_id)
        FROM (
          SELECT tenant_id, id AS swarm_id, json #>> '{board,sandboxId}' AS sandbox_id FROM swarms
          UNION ALL
          SELECT s.tenant_id, s.id, member ->> 'sandboxId'
          FROM swarms s, jsonb_array_elements(s.json -> 'members') AS member
        ) c
        WHERE r.tenant_id = c.tenant_id AND r.id = c.sandbox_id AND NOT r.json ? 'swarmId';
      END IF;
    END $$`,
  ],
};

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
  personUsedComputers?: true;
}

export type SwarmControlState = "active" | "paused" | "stopped";

const memberIndex = new WeakMap<SwarmMember[], Map<string, SwarmMember>>();

export function memberById(swarm: Swarm, id: string): SwarmMember | undefined {
  let index = memberIndex.get(swarm.members);
  if (!index || index.size !== swarm.members.length) {
    index = new Map(swarm.members.map((member) => [member.id, member]));
    memberIndex.set(swarm.members, index);
  }
  return index.get(id);
}

export function controlState(swarm: Swarm, memberId: string): SwarmControlState {
  let state: SwarmControlState = "active";
  const seen = new Set<string>();
  for (let id: string | undefined = memberId; id && !seen.has(id);) {
    seen.add(id);
    const member = memberById(swarm, id);
    if (member?.control === "stopped") return "stopped";
    if (member?.control === "paused") state = "paused";
    id = member?.parentId;
  }
  return state;
}

export function swarmExpired(swarm: Swarm): boolean {
  return swarm.expiresAt !== undefined && Date.now() >= swarm.expiresAt;
}

export function assertSwarmOpen(swarm: Swarm): void {
  if (swarmExpired(swarm)) throw new NonRetryableTurnError("swarm work window expired");
}

export interface SwarmStore {
  get(id: string): Promise<Swarm | null>;
  withForum(sandboxId: string, scopeId: string): Promise<Swarm[]>;
  create(swarm: Swarm, fence?: SwarmRunFence): Promise<Swarm>;
  update(id: string, mutate: (swarm: Swarm) => void, fence?: SwarmRunFence): Promise<Swarm>;
  pending(afterId?: string): Promise<PendingSwarm[]>;
}

export type PendingSwarm = Swarm & { tenantId: string };

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
          "INSERT INTO durable_map_versions (tbl,v) VALUES ('swarms',1) ON CONFLICT (tenant_id, tbl) DO UPDATE SET v=durable_map_versions.v+1",
        );
        const current = await client.query<{ json: SwarmStorage }>("SELECT json FROM swarms WHERE id=$1 FOR UPDATE", [
          id,
        ]);
        const next = mutate(current.rows[0]?.json ?? null);
        await client.query(
          "INSERT INTO swarms (id,json) VALUES ($1,$2) ON CONFLICT (tenant_id, id) DO UPDATE SET json=EXCLUDED.json",
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
    const updated = await backing.update(id, (current) => {
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
    async withForum(sandboxId, scopeId) {
      const rows = await backing.selectEntries({
        where: { field: "scopeId", anyOfFold: [scopeId] },
        omit: ["messages"],
      });
      const ids = rows.filter(([, row]) => row.members.some((member) => member.forumSandboxId === sandboxId));
      return (await Promise.all(ids.map(([id]) => backing.get(id)))).flatMap((row) => (row ? [decode(row)] : []));
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
          next.members.some((member) => member.state === "reserved" || member.cleanupPending) ||
          next.messages.some((message) =>
            Object.entries(message.notifications).some(
              ([id, item]) => item.state === "pending" && controlState(next, id) !== "paused",
            ),
          );
        return encode(next);
      };
      const updated = fence ? await fencedWrite(id, apply, fence) : await backing.update(id, apply);
      if (!updated) throw new Error("swarm not found");
      return decode(updated);
    },
    async pending(afterId) {
      const query = {
        where: { field: "pending", anyOfFold: ["true"] },
        afterId,
        limit: SWARM_LIMITS.sweepBatch,
      } as const;
      const claimed = await claimThenBind(backing.claimTenants, async () =>
        (await backing.select(query)).map((row) => ({ ...decode(row), tenantId: currentTenant() })),
      );
      return claimed
        .flat()
        .sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)))
        .slice(0, SWARM_LIMITS.sweepBatch);
    },
  };
}
