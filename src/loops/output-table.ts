import type { LoopOutput } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { keyValueConversion } from "../persistence/kv-conversion.ts";
import { TENANT } from "../tenants/migrations.ts";
import { createMemoryRows } from "./memory-rows.ts";
import { columnList, json, kvBigint, kvJsonb, kvTexts, num, present, text, texts, type Row } from "./pg-values.ts";

export interface OutputRows {
  insertIfAbsent(output: LoopOutput): Promise<LoopOutput>;
  get(id: string): Promise<LoopOutput | null>;
  byLoop(loopId: string): Promise<LoopOutput[]>;
  byItem(itemId: string): Promise<LoopOutput[]>;
  byAttempt(itemId: string, attemptId: string): Promise<LoopOutput[]>;
  ready(loopId: string, createdBefore?: number): Promise<LoopOutput[]>;
  update(id: string, apply: (output: LoopOutput) => LoopOutput): Promise<LoopOutput | null>;
  deleteByLoop(loopId: string): Promise<void>;
  close?(): Promise<void>;
}

export const LOOP_OUTPUTS_MIGRATION = keyValueConversion({
  table: "loop_outputs",
  columns: [
    "id TEXT NOT NULL",
    "loop_id TEXT NOT NULL",
    "item_id TEXT NOT NULL",
    "attempt_id TEXT NOT NULL",
    "ship_action TEXT NOT NULL",
    "label TEXT",
    "external_ref TEXT",
    "title TEXT NOT NULL",
    "summary TEXT",
    "state TEXT NOT NULL",
    "captured_by TEXT NOT NULL",
    "created_at BIGINT NOT NULL",
    "updated_at BIGINT NOT NULL",
    "decided_by TEXT",
    "decided_at BIGINT",
    "decision_note TEXT",
    "claimed_at BIGINT",
    "claim_token TEXT",
    "ship_fire_key TEXT",
    "ship_result JSONB",
    "supersedes_output_ids TEXT[]",
    "superseded_by_output_ids TEXT[]",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    loop_id: "json->>'loopId'",
    item_id: "json->>'itemId'",
    attempt_id: "COALESCE(json->>'attemptId', '')",
    ship_action: "COALESCE(json->>'shipAction', '')",
    label: "json->>'label'",
    external_ref: "json->>'externalRef'",
    title: "COALESCE(json->>'title', '')",
    summary: "json->>'summary'",
    state: "COALESCE(json->>'state', 'staged')",
    captured_by: "COALESCE(json->>'capturedBy', 'agent')",
    created_at: `COALESCE(${kvBigint("createdAt")}, 0)`,
    updated_at: `COALESCE(${kvBigint("updatedAt")}, ${kvBigint("createdAt")}, 0)`,
    decided_by: "json->>'decidedBy'",
    decided_at: kvBigint("decidedAt"),
    decision_note: "json->>'decisionNote'",
    claimed_at: kvBigint("claimedAt"),
    claim_token: "json->>'claimToken'",
    ship_fire_key: "json->>'shipFireKey'",
    ship_result: kvJsonb("shipResult"),
    supersedes_output_ids: kvTexts("supersedesOutputIds"),
    superseded_by_output_ids: kvTexts("supersededByOutputIds"),
  },
  where: "json->>'loopId' IS NOT NULL AND json->>'itemId' IS NOT NULL",
  indexes: [
    "CREATE INDEX loop_outputs_by_loop ON loop_outputs(tenant_id, loop_id, state, created_at)",
    "CREATE INDEX loop_outputs_by_item ON loop_outputs(tenant_id, item_id, attempt_id)",
  ],
});

const { names: COLUMNS, values: PLACEHOLDERS } = columnList([
  ["id", "text"],
  ["loop_id", "text"],
  ["item_id", "text"],
  ["attempt_id", "text"],
  ["ship_action", "text"],
  ["label", "text"],
  ["external_ref", "text"],
  ["title", "text"],
  ["summary", "text"],
  ["state", "text"],
  ["captured_by", "text"],
  ["created_at", "bigint"],
  ["updated_at", "bigint"],
  ["decided_by", "text"],
  ["decided_at", "bigint"],
  ["decision_note", "text"],
  ["claimed_at", "bigint"],
  ["claim_token", "text"],
  ["ship_fire_key", "text"],
  ["ship_result", "jsonb"],
  ["supersedes_output_ids", "text[]"],
  ["superseded_by_output_ids", "text[]"],
]);

const SELECT = `SELECT ${COLUMNS} FROM loop_outputs`;

const MINE = `tenant_id = ${TENANT}`;

function params(output: LoopOutput): unknown[] {
  return [
    output.id,
    text(output.loopId),
    text(output.itemId),
    text(output.attemptId),
    text(output.shipAction),
    text(output.label),
    text(output.externalRef),
    text(output.title),
    text(output.summary),
    output.state,
    output.capturedBy,
    output.createdAt,
    output.updatedAt,
    text(output.decidedBy),
    output.decidedAt ?? null,
    text(output.decisionNote),
    output.claimedAt ?? null,
    text(output.claimToken),
    text(output.shipFireKey),
    json(output.shipResult),
    texts(output.supersedesOutputIds),
    texts(output.supersededByOutputIds),
  ];
}

function fromRow(r: Row): LoopOutput {
  return present<LoopOutput>({
    id: r.id,
    loopId: r.loop_id,
    itemId: r.item_id,
    attemptId: r.attempt_id,
    shipAction: r.ship_action,
    label: r.label,
    externalRef: r.external_ref,
    title: r.title,
    summary: r.summary,
    state: r.state,
    capturedBy: r.captured_by,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    decidedBy: r.decided_by,
    decidedAt: num(r.decided_at),
    decisionNote: r.decision_note,
    claimedAt: num(r.claimed_at),
    claimToken: r.claim_token,
    shipFireKey: r.ship_fire_key,
    shipResult: r.ship_result,
    supersedesOutputIds: r.supersedes_output_ids,
    supersededByOutputIds: r.superseded_by_output_ids,
  });
}

export function createPostgresOutputRows(connectionString: string): OutputRows {
  const { q, pool, close } = createPgPool(connectionString, [LOOP_OUTPUTS_MIGRATION]);
  const where = async (filter: string, values: unknown[], order = "id"): Promise<LoopOutput[]> =>
    (await q(`${SELECT} WHERE ${MINE} AND ${filter} ORDER BY ${order}`, values)).map(fromRow);
  return {
    async insertIfAbsent(output) {
      await q(
        `INSERT INTO loop_outputs(${COLUMNS}) VALUES (${PLACEHOLDERS}) ON CONFLICT (tenant_id, id) DO NOTHING`,
        params(output),
      );
      return (await where("id = $1", [output.id]))[0] ?? output;
    },
    async get(id) {
      return (await where("id = $1", [id]))[0] ?? null;
    },
    byLoop: (loopId) => where("loop_id = $1", [loopId]),
    byItem: (itemId) => where("item_id = $1", [itemId]),
    byAttempt: (itemId, attemptId) => where("item_id = $1 AND attempt_id = $2", [itemId, attemptId]),
    ready: (loopId, createdBefore) =>
      createdBefore === undefined
        ? where("loop_id = $1 AND state = 'ready'", [loopId], "created_at, id")
        : where("loop_id = $1 AND state = 'ready' AND created_at < $2", [loopId, createdBefore], "created_at, id"),
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(fromRow(current.rows[0])), id };
        await client.query(
          `UPDATE loop_outputs SET (${COLUMNS}) = ROW(${PLACEHOLDERS}) WHERE ${MINE} AND id = $1`,
          params(next),
        );
        return present<LoopOutput>(next as unknown as Row);
      });
    },
    async deleteByLoop(loopId) {
      await q(`DELETE FROM loop_outputs WHERE ${MINE} AND loop_id = $1`, [loopId]);
    },
    close,
  };
}

export function createMemoryOutputRows(): OutputRows {
  const rows = createMemoryRows<LoopOutput>();
  const byCreated = (a: LoopOutput, b: LoopOutput) => a.createdAt - b.createdAt;
  return {
    async insertIfAbsent(output) {
      rows.insertIfAbsent(output);
      return rows.get(output.id) ?? output;
    },
    get: async (id) => rows.get(id),
    byLoop: async (loopId) => rows.where((output) => output.loopId === loopId),
    byItem: async (itemId) => rows.where((output) => output.itemId === itemId),
    byAttempt: async (itemId, attemptId) =>
      rows.where((output) => output.itemId === itemId && output.attemptId === attemptId),
    ready: async (loopId, createdBefore) =>
      rows
        .where(
          (output) =>
            output.loopId === loopId &&
            output.state === "ready" &&
            (createdBefore === undefined || output.createdAt < createdBefore),
        )
        .sort(byCreated),
    update: async (id, apply) => rows.update(id, apply),
    async deleteByLoop(loopId) {
      for (const output of rows.where((candidate) => candidate.loopId === loopId)) rows.delete(output.id);
    },
  };
}
