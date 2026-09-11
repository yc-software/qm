import { createKeyedQueue } from "../util/async.ts";
import type { PgPool, PoolClient } from "../persistence/pg-pool.ts";
import type { RunStore } from "../runs/run-store.ts";
import { assertRunFence, withFencedPgTransaction, type CoordinationRunFence } from "./run-fence.ts";
export type { CoordinationRunFence } from "./run-fence.ts";
import type {
  CoordinationEvent,
  CoordinationKind,
  CoordinationRows,
  PeerDelivery,
  PeerMessage,
  PeerSpawn,
} from "./types.ts";

const BLOCKED_DELIVERY_RETRY_MS = 5_000;

export interface PeerMessageQuery {
  after: number;
  limit: number;
  senderId?: string;
  recipientId?: string;
  threadId?: string;
  text?: string;
}

interface PeerMessagePage {
  messages: Omit<PeerMessage, "candidates">[];
  nextCursor: number;
  hasMore: boolean;
}

interface CoordinationRead {
  livePeerIds(after: string, limit: number): Promise<string[]>;
  get<K extends CoordinationKind>(kind: K, id: string): Promise<CoordinationRows[K] | null>;
  list<K extends CoordinationKind>(kind: K, filter?: Partial<CoordinationRows[K]>): Promise<CoordinationRows[K][]>;
  events(after: number, limit: number): Promise<CoordinationEvent[]>;
  pendingDeliveries(now: number, limit: number): Promise<PeerDelivery[]>;
  pendingSpawns(now: number, limit: number): Promise<PeerSpawn[]>;
  messagePage(query: PeerMessageQuery): Promise<PeerMessagePage>;
}

interface CoordinationTransaction extends CoordinationRead {
  sessionExists?(id: string): Promise<boolean>;
  put<K extends CoordinationKind>(kind: K, row: CoordinationRows[K]): Promise<void>;
  event(kind: CoordinationKind, id: string, at: number): Promise<number>;
}

export interface CoordinationRepository extends CoordinationRead {
  transaction<T>(
    locks: readonly string[],
    action: (tx: CoordinationTransaction) => Promise<T>,
    fence?: CoordinationRunFence,
  ): Promise<T>;
}

function eventWindow(after: number, limit: number): void {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("invalid coordination event window");
}

type MemoryRows = { [K in CoordinationKind]: Map<string, CoordinationRows[K]> };

export function createMemoryCoordinationRepository(
  deps: { runs?: Pick<RunStore, "get"> } = {},
): CoordinationRepository {
  let rows: MemoryRows = {
    peer: new Map(),
    message: new Map(),
    delivery: new Map(),
    spawn: new Map(),
  };
  let events: CoordinationEvent[] = [];
  const queue = createKeyedQueue();
  const read = (data: MemoryRows, log: CoordinationEvent[]): CoordinationRead => ({
    async livePeerIds(after, limit) {
      eventWindow(0, limit);
      return [...data.peer.values()]
        .filter((peer) => peer.state !== "deleted" && Buffer.compare(Buffer.from(peer.id), Buffer.from(after)) > 0)
        .map((peer) => peer.id)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .slice(0, limit);
    },
    async get(kind, id) {
      return structuredClone(data[kind].get(id) ?? null);
    },
    async list(kind, filter = {}) {
      return structuredClone(
        [...data[kind].values()]
          .filter((row) =>
            Object.entries(filter).every(
              ([key, value]) => JSON.stringify(row[key as keyof typeof row]) === JSON.stringify(value),
            ),
          )
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    },
    async events(after, limit) {
      eventWindow(after, limit);
      return structuredClone(log.filter((event) => event.sequence > after).slice(0, limit));
    },
    async pendingDeliveries(now, limit) {
      eventWindow(now, limit);
      return structuredClone(
        [...data.delivery.values()]
          .filter(
            (row) =>
              row.state !== "delivered" &&
              row.state !== "failed" &&
              row.leaseUntil <= now &&
              (row.state !== "blocked" || row.updatedAt + BLOCKED_DELIVERY_RETRY_MS <= now),
          )
          .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
          .slice(0, limit),
      );
    },
    async pendingSpawns(now, limit) {
      eventWindow(now, limit);
      const eligibleAt = (spawn: PeerSpawn) =>
        Math.max(spawn.leaseUntil, spawn.state === "failed" ? spawn.updatedAt + 5_000 : 0);
      return structuredClone(
        [...data.spawn.values()]
          .filter((spawn) => spawn.state !== "ready" && eligibleAt(spawn) <= now)
          .sort((a, b) => eligibleAt(a) - eligibleAt(b) || a.id.localeCompare(b.id))
          .slice(0, limit),
      );
    },
    async messagePage(query) {
      eventWindow(query.after, query.limit);
      const text = query.text?.toLowerCase();
      const rows = [...data.message.values()]
        .filter(
          (message) =>
            message.sequence > query.after &&
            (!query.senderId || message.senderId === query.senderId) &&
            (!query.recipientId || message.recipientIds.includes(query.recipientId)) &&
            (!query.threadId || message.threadId === query.threadId) &&
            (!text || message.text.toLowerCase().includes(text)),
        )
        .sort((a, b) => a.sequence - b.sequence);
      const messages = rows.slice(0, query.limit).map((message) => {
        const summary: Partial<PeerMessage> = { ...message };
        delete summary.candidates;
        return summary as Omit<PeerMessage, "candidates">;
      });
      return structuredClone({
        messages,
        nextCursor: messages.at(-1)?.sequence ?? query.after,
        hasMore: rows.length > query.limit,
      });
    },
  });
  return {
    get: (kind, id) => read(rows, events).get(kind, id),
    list: (kind, filter) => read(rows, events).list(kind, filter),
    events: (after, limit) => read(rows, events).events(after, limit),
    pendingDeliveries: (now, limit) => read(rows, events).pendingDeliveries(now, limit),
    pendingSpawns: (now, limit) => read(rows, events).pendingSpawns(now, limit),
    livePeerIds: (after, limit) => read(rows, events).livePeerIds(after, limit),
    messagePage: (query) => read(rows, events).messagePage(query),
    transaction: (_locks, action, fence) =>
      queue("transaction", async () => {
        const run = fence ? ((await deps.runs?.get(fence.runId)) ?? null) : null;
        if (fence) assertRunFence(fence, run);
        const next = structuredClone(rows);
        const log = structuredClone(events);
        const tx: CoordinationTransaction = {
          ...read(next, log),
          async put<K extends CoordinationKind>(kind: K, row: CoordinationRows[K]) {
            const table: Map<string, CoordinationRows[K]> = next[kind];
            table.set(row.id, structuredClone(row));
          },
          async event(kind, id, at) {
            const sequence = (log.at(-1)?.sequence ?? 0) + 1;
            log.push({ sequence, kind, id, at });
            return sequence;
          },
        };
        const result = await action(tx);
        if (fence) assertRunFence(fence, run);
        rows = next;
        events = log;
        return structuredClone(result);
      }),
  };
}

const spawnEligibility =
  "GREATEST((json->>'leaseUntil')::bigint, CASE WHEN json->>'state'='failed' THEN (json->>'updatedAt')::bigint + 5000 ELSE 0 END)";

const migration = {
  id: "coordination/0001",
  statements: [
    `CREATE TABLE IF NOT EXISTS coordination_records (
      org_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, json JSONB NOT NULL,
      PRIMARY KEY (org_id, kind, id),
      CHECK (kind IN ('peer', 'message', 'delivery', 'spawn')),
      CHECK (json->>'id' = id))`,
    `CREATE INDEX IF NOT EXISTS coordination_records_filter ON coordination_records USING GIN (json jsonb_path_ops)`,
    `CREATE TABLE IF NOT EXISTS coordination_cursors (org_id TEXT PRIMARY KEY, seq BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS coordination_events (
      org_id TEXT NOT NULL, seq BIGINT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, at BIGINT NOT NULL,
      PRIMARY KEY (org_id, seq))`,
    `CREATE INDEX IF NOT EXISTS coordination_pending_deliveries
      ON coordination_records (org_id, ((json->>'updatedAt')::bigint), id COLLATE "C")
      WHERE kind = 'delivery' AND json->>'state' IN ('queued', 'blocked')`,
    `CREATE INDEX IF NOT EXISTS coordination_message_sequence
      ON coordination_records (org_id, ((json->>'sequence')::bigint)) WHERE kind='message'`,
    `CREATE INDEX IF NOT EXISTS coordination_pending_spawns ON coordination_records
    (org_id, (${spawnEligibility}), id COLLATE "C") WHERE kind='spawn' AND json->>'state' IN ('reserved', 'provisioning', 'failed')`,

    `CREATE INDEX IF NOT EXISTS coordination_live_peer_page ON coordination_records
      (org_id, id COLLATE "C") WHERE kind='peer' AND json->>'state'<>'deleted'`,
  ],
};

export function createPostgresCoordinationRepository(
  pg: PgPool,
  orgId: string,
  opts: { postgresSessions?: boolean } = {},
): CoordinationRepository {
  if (!orgId) throw new Error("coordination requires an organization");
  pg.registerMigration(migration);
  let initializing: Promise<void> | undefined;
  const ready = () =>
    (initializing ??= pg.migrate(migration).catch((error) => {
      initializing = undefined;
      throw error;
    }));
  const read = (client?: PoolClient): CoordinationRead => {
    const query = async (sql: string, values: unknown[]) => {
      if (client) return (await client.query(sql, values)).rows;
      await ready();
      return pg.q(sql, values);
    };
    return {
      async livePeerIds(after, limit) {
        eventWindow(0, limit);
        const rows = await query(
          `SELECT id FROM coordination_records WHERE org_id=$1 AND kind='peer'
          AND json->>'state'<>'deleted' AND id COLLATE "C">$2 COLLATE "C" ORDER BY id COLLATE "C" LIMIT $3`,
          [orgId, after, limit],
        );
        return rows.map((row) => row.id as string);
      },
      async get(kind, id) {
        const result = await query("SELECT json FROM coordination_records WHERE org_id=$1 AND kind=$2 AND id=$3", [
          orgId,
          kind,
          id,
        ]);
        return result[0]?.json ?? null;
      },
      async list(kind, filter = {}) {
        const result = await query(
          "SELECT json FROM coordination_records WHERE org_id=$1 AND kind=$2 AND json @> $3::jsonb ORDER BY id",
          [orgId, kind, JSON.stringify(filter)],
        );
        return result.map((row) => row.json);
      },
      async events(after, limit) {
        eventWindow(after, limit);
        const result = await query(
          "SELECT seq, kind, id, at FROM coordination_events WHERE org_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
          [orgId, after, limit],
        );
        return result.map((row) => ({ sequence: Number(row.seq), kind: row.kind, id: row.id, at: Number(row.at) }));
      },
      async pendingDeliveries(now, limit) {
        eventWindow(now, limit);
        const result = await query(
          `SELECT json FROM coordination_records
           WHERE org_id=$1 AND kind='delivery'
             AND json->>'state' IN ('queued', 'blocked')
             AND (json->>'leaseUntil')::bigint <= $2
             AND (json->>'state' <> 'blocked' OR (json->>'updatedAt')::bigint + $4 <= $2)
           ORDER BY (json->>'updatedAt')::bigint, id COLLATE "C" LIMIT $3`,
          [orgId, now, limit, BLOCKED_DELIVERY_RETRY_MS],
        );
        return result.map((row) => row.json);
      },
      async pendingSpawns(now, limit) {
        eventWindow(now, limit);
        const result = await query(
          `SELECT json FROM coordination_records WHERE org_id=$1 AND kind='spawn'
          AND json->>'state' IN ('reserved', 'provisioning', 'failed') AND ${spawnEligibility} <= $2
          ORDER BY ${spawnEligibility}, id COLLATE "C" LIMIT $3`,
          [orgId, now, limit],
        );
        return result.map((row) => row.json);
      },
      async messagePage(input) {
        eventWindow(input.after, input.limit);
        const values: unknown[] = [orgId, input.after];
        const parameter = (value: unknown) => {
          values.push(value);
          return `$${values.length}`;
        };
        const conditions = ["m.org_id=$1", "m.kind='message'", "(m.json->>'sequence')::bigint>$2"];
        if (input.senderId) conditions.push(`m.json->>'senderId'=${parameter(input.senderId)}`);
        if (input.recipientId)
          conditions.push(`m.json @> ${parameter(JSON.stringify({ recipientIds: [input.recipientId] }))}::jsonb`);
        if (input.threadId) conditions.push(`m.json->>'threadId'=${parameter(input.threadId)}`);
        if (input.text) conditions.push(`strpos(lower(m.json->>'text'), lower(${parameter(input.text)}))>0`);
        const result = await query(
          `SELECT m.json - 'candidates' AS json FROM coordination_records m WHERE ${conditions.join(" AND ")}
           ORDER BY (m.json->>'sequence')::bigint LIMIT ${parameter(input.limit + 1)}`,
          values,
        );
        const messages = result.slice(0, input.limit).map((row) => row.json as Omit<PeerMessage, "candidates">);
        return { messages, nextCursor: messages.at(-1)?.sequence ?? input.after, hasMore: result.length > input.limit };
      },
    };
  };
  return {
    ...read(),
    async transaction(locks, action, fence) {
      await ready();
      return withFencedPgTransaction(
        pg,
        async (client) => {
          for (const key of [...new Set(locks)].sort()) {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
              JSON.stringify(["coordination", orgId, key]),
            ]);
          }
          const result = await action({
            ...read(client),
            ...(opts.postgresSessions
              ? {
                  sessionExists: async (id: string) => {
                    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
                    const result = await client.query("SELECT 1 FROM sessions WHERE id=$1", [id]);
                    return result.rows.length > 0;
                  },
                }
              : {}),
            async put(kind, row) {
              await client.query(
                "INSERT INTO coordination_records (org_id, kind, id, json) VALUES ($1,$2,$3,$4) ON CONFLICT (org_id,kind,id) DO UPDATE SET json=EXCLUDED.json",
                [orgId, kind, row.id, JSON.stringify(row)],
              );
            },
            async event(kind, id, at) {
              const result = await client.query(
                "INSERT INTO coordination_cursors (org_id,seq) VALUES ($1,1) ON CONFLICT (org_id) DO UPDATE SET seq=coordination_cursors.seq+1 RETURNING seq",
                [orgId],
              );
              const sequence = Number(result.rows[0].seq);
              if (!Number.isSafeInteger(sequence)) throw new Error("coordination event sequence exhausted");
              await client.query("INSERT INTO coordination_events (org_id,seq,kind,id,at) VALUES ($1,$2,$3,$4,$5)", [
                orgId,
                sequence,
                kind,
                id,
                at,
              ]);
              return sequence;
            },
          });
          return result;
        },
        fence,
      );
    },
  };
}
