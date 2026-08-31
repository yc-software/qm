import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { createPgPool, withPgTransaction } from "./pg-pool.ts";

export interface TransactionalOutboxEntry {
  contractVersion: 1;
  id: string;
  topic: string;
  payloadJson: string;
  payloadSha256: string;
  createdAt: number;
}

export interface TransactionalOutboxClaim extends TransactionalOutboxEntry {
  attempts: number;
  leaseToken: string;
}

export interface TransactionalOutboxPublisher {
  publish(entry: TransactionalOutboxEntry): void;
}

export interface TransactionalOutboxStorage {
  stage(entry: TransactionalOutboxEntry): Promise<void>;
  claim(
    topic: string,
    limit: number,
    leaseToken: string,
    leaseMs: number,
    now: number,
  ): Promise<TransactionalOutboxClaim[]>;
  claimId(
    topic: string,
    id: string,
    leaseToken: string,
    leaseMs: number,
    now: number,
  ): Promise<TransactionalOutboxClaim | null>;
  deliver(id: string, leaseToken: string, outcome: "accepted" | "duplicate", now: number): Promise<boolean>;
  retry(id: string, leaseToken: string, nextAttemptAt: number, now: number): Promise<boolean>;
  get(id: string): Promise<{
    entry: TransactionalOutboxEntry;
    state: "pending" | "delivering" | "delivered";
    attempts: number;
    nextAttemptAt: number;
    leaseToken?: string;
    leaseExpiresAt?: number;
    lastOutcome?: "accepted" | "duplicate" | "unconfirmed";
  } | null>;
  close?(): Promise<void>;
}

export const TRANSACTIONAL_OUTBOX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS transactional_outbox(
     id TEXT PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
     state TEXT NOT NULL, attempts INT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
     next_attempt_at BIGINT NOT NULL, lease_token TEXT, lease_expires_at BIGINT, last_outcome TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transactional_outbox_due
     ON transactional_outbox(topic, next_attempt_at, created_at, id) WHERE state <> 'delivered'`,
] as const;

const SAFE_ID = /^[^\u0000-\u001F\u007F]{1,512}$/u;
const SAFE_TOPIC = /^[a-z][a-z0-9._-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function createTransactionalOutboxEntry(input: {
  id: string;
  topic: string;
  payloadJson: string;
  createdAt: number;
}): TransactionalOutboxEntry {
  if (!SAFE_ID.test(input.id)) throw new TypeError("transactional outbox id is invalid");
  if (!SAFE_TOPIC.test(input.topic)) throw new TypeError("transactional outbox topic is invalid");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new TypeError("transactional outbox createdAt is invalid");
  }
  let normalized: string;
  try {
    normalized = JSON.stringify(JSON.parse(input.payloadJson));
  } catch {
    throw new TypeError("transactional outbox payload must be JSON");
  }
  if (normalized !== input.payloadJson) throw new TypeError("transactional outbox payload must be normalized JSON");
  return Object.freeze({
    contractVersion: 1,
    id: input.id,
    topic: input.topic,
    payloadJson: input.payloadJson,
    payloadSha256: createHash("sha256").update(input.payloadJson).digest("hex"),
    createdAt: input.createdAt,
  });
}

export function validateTransactionalOutboxEntry(value: TransactionalOutboxEntry): TransactionalOutboxEntry {
  if (
    value.contractVersion !== 1 ||
    !DIGEST.test(value.payloadSha256) ||
    createTransactionalOutboxEntry(value).payloadSha256 !== value.payloadSha256
  ) {
    throw new TypeError("transactional outbox entry is invalid");
  }
  return value;
}

export async function insertTransactionalOutbox(client: PoolClient, value: TransactionalOutboxEntry): Promise<void> {
  const entry = validateTransactionalOutboxEntry(value);
  const result = await client.query(
    `INSERT INTO transactional_outbox(
       id, topic, payload, payload_sha256, state, attempts, created_at, updated_at, next_attempt_at
     ) VALUES ($1,$2,$3,$4,'pending',0,$5,$5,$5)
     ON CONFLICT (id) DO UPDATE SET id=transactional_outbox.id
     WHERE transactional_outbox.topic=EXCLUDED.topic
       AND transactional_outbox.payload_sha256=EXCLUDED.payload_sha256
       AND transactional_outbox.payload=EXCLUDED.payload
     RETURNING id`,
    [entry.id, entry.topic, entry.payloadJson, entry.payloadSha256, entry.createdAt],
  );
  if (!result.rows[0]) throw new Error("transactional outbox identity is already bound to a different payload");
}

interface MemoryRecord {
  entry: TransactionalOutboxEntry;
  state: "pending" | "delivering" | "delivered";
  attempts: number;
  updatedAt: number;
  nextAttemptAt: number;
  leaseToken?: string;
  leaseExpiresAt?: number;
  lastOutcome?: "accepted" | "duplicate" | "unconfirmed";
}

function memorySnapshot(record: MemoryRecord) {
  return structuredClone({
    entry: record.entry,
    state: record.state,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    ...(record.leaseToken ? { leaseToken: record.leaseToken } : {}),
    ...(record.leaseExpiresAt !== undefined ? { leaseExpiresAt: record.leaseExpiresAt } : {}),
    ...(record.lastOutcome ? { lastOutcome: record.lastOutcome } : {}),
  });
}

export function createMemoryTransactionalOutbox(): TransactionalOutboxStorage & TransactionalOutboxPublisher {
  const records = new Map<string, MemoryRecord>();
  const claimable = (record: MemoryRecord, now: number) =>
    record.state === "pending"
      ? record.nextAttemptAt <= now
      : record.state === "delivering" && (record.leaseExpiresAt ?? 0) <= now;
  const claimRecord = (record: MemoryRecord, leaseToken: string, leaseMs: number, now: number) => {
    record.state = "delivering";
    record.attempts += 1;
    record.updatedAt = now;
    record.leaseToken = leaseToken;
    record.leaseExpiresAt = now + leaseMs;
    return Object.freeze({ ...record.entry, attempts: record.attempts, leaseToken });
  };
  const publish = (value: TransactionalOutboxEntry) => {
    const entry = validateTransactionalOutboxEntry(value);
    const existing = records.get(entry.id);
    if (existing) {
      if (
        existing.entry.topic !== entry.topic ||
        existing.entry.payloadSha256 !== entry.payloadSha256 ||
        existing.entry.payloadJson !== entry.payloadJson
      ) {
        throw new Error("transactional outbox identity is already bound to a different payload");
      }
      return;
    }
    records.set(entry.id, {
      entry,
      state: "pending",
      attempts: 0,
      updatedAt: entry.createdAt,
      nextAttemptAt: entry.createdAt,
    });
  };
  return {
    publish,
    async stage(value) {
      publish(value);
    },
    async claim(topic, limit, leaseToken, leaseMs, now) {
      return [...records.values()]
        .filter((record) => record.entry.topic === topic && claimable(record, now))
        .sort(
          (left, right) =>
            left.nextAttemptAt - right.nextAttemptAt ||
            left.entry.createdAt - right.entry.createdAt ||
            left.entry.id.localeCompare(right.entry.id),
        )
        .slice(0, limit)
        .map((record) => claimRecord(record, leaseToken, leaseMs, now));
    },
    async claimId(topic, id, leaseToken, leaseMs, now) {
      const record = records.get(id);
      if (!record || record.entry.topic !== topic || !claimable(record, now)) return null;
      return claimRecord(record, leaseToken, leaseMs, now);
    },
    async deliver(id, leaseToken, outcome, now) {
      const record = records.get(id);
      if (!record || record.state !== "delivering" || record.leaseToken !== leaseToken) return false;
      record.state = "delivered";
      record.updatedAt = now;
      record.nextAttemptAt = now;
      record.lastOutcome = outcome;
      delete record.leaseToken;
      delete record.leaseExpiresAt;
      return true;
    },
    async retry(id, leaseToken, nextAttemptAt, now) {
      const record = records.get(id);
      if (!record || record.state !== "delivering" || record.leaseToken !== leaseToken) return false;
      record.state = "pending";
      record.updatedAt = now;
      record.nextAttemptAt = nextAttemptAt;
      record.lastOutcome = "unconfirmed";
      delete record.leaseToken;
      delete record.leaseExpiresAt;
      return true;
    },
    async get(id) {
      const record = records.get(id);
      return record ? memorySnapshot(record) : null;
    },
  };
}

export function createPostgresTransactionalOutbox(connectionString: string): TransactionalOutboxStorage {
  const pg = createPgPool(connectionString, [...TRANSACTIONAL_OUTBOX_SCHEMA]);
  const rowToClaim = (row: Record<string, unknown>): TransactionalOutboxClaim =>
    Object.freeze({
      contractVersion: 1,
      id: row.id as string,
      topic: row.topic as string,
      payloadJson: row.payload_json as string,
      payloadSha256: row.payload_sha256 as string,
      createdAt: Number(row.created_at),
      attempts: Number(row.attempts),
      leaseToken: row.lease_token as string,
    });
  const claimWhere = async (
    where: string,
    values: unknown[],
    limit: number,
    leaseToken: string,
    leaseMs: number,
    now: number,
  ) => {
    const { rows } = await pg.query(
      `WITH due AS (
         SELECT id FROM transactional_outbox
         WHERE ${where}
           AND ((state='pending' AND next_attempt_at <= $${values.length + 1})
             OR (state='delivering' AND lease_expires_at <= $${values.length + 1}))
         ORDER BY next_attempt_at, created_at, id
         FOR UPDATE SKIP LOCKED LIMIT $${values.length + 2}
       )
       UPDATE transactional_outbox AS item
       SET state='delivering', attempts=item.attempts+1, updated_at=$${values.length + 1},
           lease_token=$${values.length + 3}, lease_expires_at=$${values.length + 4}
       FROM due WHERE item.id=due.id
       RETURNING item.id, item.topic, item.payload AS payload_json, item.payload_sha256,
         item.created_at, item.attempts, item.lease_token`,
      [...values, now, limit, leaseToken, now + leaseMs],
    );
    return rows.map(rowToClaim);
  };
  return {
    async stage(entry) {
      validateTransactionalOutboxEntry(entry);
      await withPgTransaction(await pg.pool(), (client) => insertTransactionalOutbox(client, entry));
    },
    claim(topic, limit, leaseToken, leaseMs, now) {
      return claimWhere("topic=$1", [topic], limit, leaseToken, leaseMs, now);
    },
    async claimId(topic, id, leaseToken, leaseMs, now) {
      return (await claimWhere("topic=$1 AND id=$2", [topic, id], 1, leaseToken, leaseMs, now))[0] ?? null;
    },
    async deliver(id, leaseToken, outcome, now) {
      const result = await pg.query(
        `UPDATE transactional_outbox
         SET state='delivered', updated_at=$3, next_attempt_at=$3, last_outcome=$4,
             lease_token=NULL, lease_expires_at=NULL
         WHERE id=$1 AND state='delivering' AND lease_token=$2`,
        [id, leaseToken, now, outcome],
      );
      return result.rowCount > 0;
    },
    async retry(id, leaseToken, nextAttemptAt, now) {
      const result = await pg.query(
        `UPDATE transactional_outbox
         SET state='pending', updated_at=$3, next_attempt_at=$4, last_outcome='unconfirmed',
             lease_token=NULL, lease_expires_at=NULL
         WHERE id=$1 AND state='delivering' AND lease_token=$2`,
        [id, leaseToken, now, nextAttemptAt],
      );
      return result.rowCount > 0;
    },
    async get(id) {
      const { rows } = await pg.query(
        `SELECT id, topic, payload AS payload_json, payload_sha256, created_at, state, attempts,
           next_attempt_at, lease_token, lease_expires_at, last_outcome
         FROM transactional_outbox WHERE id=$1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        entry: {
          contractVersion: 1,
          id: row.id as string,
          topic: row.topic as string,
          payloadJson: row.payload_json as string,
          payloadSha256: row.payload_sha256 as string,
          createdAt: Number(row.created_at),
        },
        state: row.state as "pending" | "delivering" | "delivered",
        attempts: Number(row.attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        ...(row.lease_token ? { leaseToken: row.lease_token as string } : {}),
        ...(row.lease_expires_at !== null ? { leaseExpiresAt: Number(row.lease_expires_at) } : {}),
        ...(row.last_outcome ? { lastOutcome: row.last_outcome as "accepted" | "duplicate" | "unconfirmed" } : {}),
      };
    },
    close: () => pg.close(),
  };
}
