import type { LoopItem } from "../types.ts";
import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { createMemoryRows } from "./memory-rows.ts";
import { columnList, json, kvBigint, kvJsonb, kvTexts, num, present, text, texts, type Row } from "./pg-values.ts";

export type ItemSummary = Omit<LoopItem, "proposal" | "agentDrafts" | "thread" | "sourcePayload"> &
  Partial<Pick<LoopItem, "sourcePayload">>;

export type ItemLifecycle = Pick<LoopItem, "id" | "status" | "createdAt" | "updatedAt" | "actedAt">;

export interface ItemRows {
  get(id: string): Promise<LoopItem | null>;
  byLoop(loopId: string): Promise<LoopItem[]>;
  summaries(loopIds: readonly string[], payloadKeys?: readonly string[]): Promise<ItemSummary[]>;
  idsBySourceKey(loopId: string, sourceKeys: readonly string[]): Promise<Array<{ id: string; sourceKey: string }>>;
  lifecycle(loopId: string): Promise<ItemLifecycle[]>;
  queued(loopId: string, staleClaimBefore: number, limit?: number): Promise<LoopItem[]>;
  insertIfAbsent(item: LoopItem): Promise<boolean>;
  update(id: string, apply: (item: LoopItem) => LoopItem): Promise<LoopItem | null>;
  mutateMany(updates: ReadonlyArray<{ id: string; apply: (item: LoopItem | null) => LoopItem }>): Promise<LoopItem[]>;
  delete(ids: readonly string[]): Promise<void>;
  deleteByLoop(loopId: string): Promise<void>;
  close?(): Promise<void>;
}

export const LOOP_ITEMS_MIGRATION = typedTableMigration({
  table: "loop_items",
  columns: [
    "id TEXT NOT NULL",
    "loop_id TEXT NOT NULL",
    "previous_loop_id TEXT",
    "source_key TEXT NOT NULL",
    "source_summary TEXT",
    "source TEXT",
    "source_payload JSONB",
    "inbox_preview JSONB",
    "source_at BIGINT",
    "proposal JSONB",
    "agent_drafts JSONB",
    "agent_mention_keys TEXT[]",
    "thread JSONB",
    "triage JSONB",
    "status TEXT NOT NULL",
    "attempts INTEGER NOT NULL",
    "run_ids TEXT[] NOT NULL",
    "output_ids TEXT[] NOT NULL",
    "parked_reason TEXT",
    "guidance TEXT",
    "acted_at BIGINT",
    "action_kind TEXT",
    "action_result TEXT",
    "claimed_at BIGINT",
    "claim_token TEXT",
    "decision_at BIGINT",
    "decision_token TEXT",
    "created_at BIGINT NOT NULL",
    "updated_at BIGINT NOT NULL",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    loop_id: "json->>'loopId'",
    previous_loop_id: "json->>'previousLoopId'",
    source_key: "json->>'sourceKey'",
    source_summary: "json->>'sourceSummary'",
    source: "json->>'source'",
    source_payload: kvJsonb("sourcePayload"),
    inbox_preview: kvJsonb("inboxPreview"),
    source_at: kvBigint("sourceAt"),
    proposal: kvJsonb("proposal"),
    agent_drafts: kvJsonb("agentDrafts"),
    agent_mention_keys: kvTexts("agentMentionKeys"),
    thread: kvJsonb("thread"),
    triage: kvJsonb("triage"),
    status: "COALESCE(json->>'status', 'queued')",
    attempts: "COALESCE((json->>'attempts')::integer, 0)",
    run_ids: `COALESCE(${kvTexts("runIds")}, '{}')`,
    output_ids: `COALESCE(${kvTexts("outputIds")}, '{}')`,
    parked_reason: "json->>'parkedReason'",
    guidance: "json->>'guidance'",
    acted_at: kvBigint("actedAt"),
    action_kind: "json->>'actionKind'",
    action_result: "json->>'actionResult'",
    claimed_at: kvBigint("claimedAt"),
    claim_token: "json->>'claimToken'",
    decision_at: kvBigint("decisionAt"),
    decision_token: "json->>'decisionToken'",
    created_at: `COALESCE(${kvBigint("createdAt")}, 0)`,
    updated_at: `COALESCE(${kvBigint("updatedAt")}, ${kvBigint("createdAt")}, 0)`,
  },
  where: "json->>'loopId' IS NOT NULL AND json->>'sourceKey' IS NOT NULL",
  indexes: ["CREATE INDEX loop_items_by_source_key ON loop_items(tenant_id, loop_id, source_key)"],
});

const SUMMARY_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["id", "text"],
  ["loop_id", "text"],
  ["previous_loop_id", "text"],
  ["source_key", "text"],
  ["source_summary", "text"],
  ["source", "text"],
  ["inbox_preview", "jsonb"],
  ["source_at", "bigint"],
  ["agent_mention_keys", "text[]"],
  ["triage", "jsonb"],
  ["status", "text"],
  ["attempts", "integer"],
  ["run_ids", "text[]"],
  ["output_ids", "text[]"],
  ["parked_reason", "text"],
  ["guidance", "text"],
  ["acted_at", "bigint"],
  ["action_kind", "text"],
  ["action_result", "text"],
  ["claimed_at", "bigint"],
  ["claim_token", "text"],
  ["decision_at", "bigint"],
  ["decision_token", "text"],
  ["created_at", "bigint"],
  ["updated_at", "bigint"],
];

const SUMMARY = columnList(SUMMARY_COLUMNS).names;

const { names: COLUMNS, values: PLACEHOLDERS } = columnList([
  ...SUMMARY_COLUMNS,
  ["source_payload", "jsonb"],
  ["proposal", "jsonb"],
  ["agent_drafts", "jsonb"],
  ["thread", "jsonb"],
]);

const SELECT = `SELECT ${COLUMNS} FROM loop_items`;

const MINE = `tenant_id = ${TENANT}`;

const UPSERT = `INSERT INTO loop_items(${COLUMNS}) VALUES (${PLACEHOLDERS})
  ON CONFLICT (tenant_id, id) DO UPDATE SET (${COLUMNS}) = ROW(${COLUMNS.split(", ")
    .map((name) => `EXCLUDED.${name}`)
    .join(", ")})`;

function params(item: LoopItem): unknown[] {
  return [
    item.id,
    text(item.loopId),
    text(item.previousLoopId),
    text(item.sourceKey),
    text(item.sourceSummary),
    text(item.source),
    json(item.inboxPreview),
    item.sourceAt ?? null,
    texts(item.agentMentionKeys),
    json(item.triage),
    item.status,
    item.attempts,
    texts(item.runIds),
    texts(item.outputIds),
    text(item.parkedReason),
    text(item.guidance),
    item.actedAt ?? null,
    text(item.actionKind),
    text(item.actionResult),
    item.claimedAt ?? null,
    text(item.claimToken),
    item.decisionAt ?? null,
    text(item.decisionToken),
    item.createdAt,
    item.updatedAt,
    json(item.sourcePayload),
    json(item.proposal),
    json(item.agentDrafts),
    json(item.thread),
  ];
}

function fromRow(r: Row): LoopItem {
  return present<LoopItem>({
    id: r.id,
    loopId: r.loop_id,
    previousLoopId: r.previous_loop_id,
    sourceKey: r.source_key,
    sourceSummary: r.source_summary,
    source: r.source,
    inboxPreview: r.inbox_preview,
    sourceAt: num(r.source_at),
    agentMentionKeys: r.agent_mention_keys,
    triage: r.triage,
    status: r.status,
    attempts: r.attempts,
    runIds: r.run_ids,
    outputIds: r.output_ids,
    parkedReason: r.parked_reason,
    guidance: r.guidance,
    actedAt: num(r.acted_at),
    actionKind: r.action_kind,
    actionResult: r.action_result,
    claimedAt: num(r.claimed_at),
    claimToken: r.claim_token,
    decisionAt: num(r.decision_at),
    decisionToken: r.decision_token,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    sourcePayload: r.source_payload,
    proposal: r.proposal,
    agentDrafts: r.agent_drafts,
    thread: r.thread,
  });
}

export function createPostgresItemRows(connectionString: string): ItemRows {
  const { q, pool, close } = createPgPool(connectionString, [TENANCY_BASE, LOOP_ITEMS_MIGRATION]);
  return {
    async get(id) {
      const rows = await q(`${SELECT} WHERE ${MINE} AND id = $1`, [id]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async byLoop(loopId) {
      return (await q(`${SELECT} WHERE ${MINE} AND loop_id = $1 ORDER BY id`, [loopId])).map(fromRow);
    },
    async summaries(loopIds, payloadKeys) {
      if (!loopIds.length) return [];
      const payload = payloadKeys
        ? `, CASE WHEN jsonb_typeof(source_payload) = 'object' THEN (SELECT jsonb_object_agg(key, value)
             FROM jsonb_each(source_payload) WHERE key = ANY($2::text[])) END AS source_payload`
        : "";
      const rows = await q(
        `SELECT ${SUMMARY}${payload} FROM loop_items WHERE ${MINE} AND loop_id = ANY($1::text[]) ORDER BY id`,
        payloadKeys ? [[...loopIds], [...payloadKeys]] : [[...loopIds]],
      );
      return rows.map((row) => fromRow(row) as ItemSummary);
    },
    async idsBySourceKey(loopId, sourceKeys) {
      if (!sourceKeys.length) return [];
      const rows = await q(
        `SELECT id, source_key FROM loop_items
          WHERE ${MINE} AND loop_id = $1 AND source_key = ANY($2::text[]) ORDER BY id`,
        [loopId, texts(sourceKeys)],
      );
      return rows.map((row) => ({ id: row.id as string, sourceKey: row.source_key as string }));
    },
    async lifecycle(loopId) {
      const rows = await q(
        `SELECT id, status, created_at, updated_at, acted_at FROM loop_items WHERE ${MINE} AND loop_id = $1 ORDER BY id`,
        [loopId],
      );
      return rows.map((row) => fromRow(row) as unknown as ItemLifecycle);
    },
    async queued(loopId, staleClaimBefore, limit) {
      const rows = await q(
        `${SELECT} WHERE ${MINE} AND loop_id = $1
           AND (status = 'queued' OR (status = 'in_progress' AND COALESCE(claimed_at, 0) <= $2))
         ORDER BY created_at, id LIMIT $3`,
        [loopId, staleClaimBefore, limit ?? null],
      );
      return rows.map(fromRow);
    },
    async insertIfAbsent(item) {
      const inserted = await q(
        `INSERT INTO loop_items(${COLUMNS}) VALUES (${PLACEHOLDERS}) ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id`,
        params(item),
      );
      return inserted.length > 0;
    },
    async update(id, apply) {
      return withPgTransaction(await pool(), async (client) => {
        const current = await client.query(`${SELECT} WHERE ${MINE} AND id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = { ...apply(fromRow(current.rows[0])), id };
        await client.query(
          `UPDATE loop_items SET (${COLUMNS}) = ROW(${PLACEHOLDERS}) WHERE ${MINE} AND id = $1`,
          params(next),
        );
        return present<LoopItem>(next as unknown as Row);
      });
    },
    async mutateMany(updates) {
      if (!updates.length) return [];
      return withPgTransaction(await pool(), async (client) => {
        const ids = [...new Set(updates.map((update) => update.id))].sort();
        const current = await client.query(`${SELECT} WHERE ${MINE} AND id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [
          ids,
        ]);
        const items = new Map<string, LoopItem>(current.rows.map((row) => [row.id as string, fromRow(row)]));
        const results = updates.map(({ id, apply }) => {
          const next = present<LoopItem>({ ...apply(items.get(id) ?? null), id } as unknown as Row);
          items.set(id, next);
          return next;
        });
        for (const id of ids) await client.query(UPSERT, params(items.get(id)!));
        return results;
      });
    },
    async delete(ids) {
      if (ids.length) await q(`DELETE FROM loop_items WHERE ${MINE} AND id = ANY($1::text[])`, [[...ids]]);
    },
    async deleteByLoop(loopId) {
      await q(`DELETE FROM loop_items WHERE ${MINE} AND loop_id = $1`, [loopId]);
    },
    close,
  };
}

export function createMemoryItemRows(): ItemRows {
  const rows = createMemoryRows<LoopItem>();
  const strip = (
    { proposal: _p, agentDrafts: _d, thread: _t, sourcePayload, ...item }: LoopItem,
    keys?: readonly string[],
  ) =>
    present<ItemSummary>({
      ...item,
      sourcePayload:
        keys && sourcePayload && typeof sourcePayload === "object" && !Array.isArray(sourcePayload)
          ? Object.fromEntries(Object.entries(sourcePayload).filter(([key]) => keys.includes(key)))
          : undefined,
    });
  return {
    get: async (id) => rows.get(id),
    byLoop: async (loopId) => rows.where((item) => item.loopId === loopId),
    summaries: async (loopIds, payloadKeys) =>
      rows.where((item) => loopIds.includes(item.loopId)).map((item) => strip(item, payloadKeys)),
    idsBySourceKey: async (loopId, sourceKeys) =>
      rows
        .where((item) => item.loopId === loopId && sourceKeys.includes(item.sourceKey))
        .map(({ id, sourceKey }) => ({ id, sourceKey })),
    lifecycle: async (loopId) =>
      rows
        .where((item) => item.loopId === loopId)
        .map(({ id, status, createdAt, updatedAt, actedAt }) =>
          present<ItemLifecycle>({ id, status, createdAt, updatedAt, actedAt }),
        ),
    queued: async (loopId, staleClaimBefore, limit) => {
      const queued = rows
        .where(
          (item) =>
            item.loopId === loopId &&
            (item.status === "queued" || (item.status === "in_progress" && (item.claimedAt ?? 0) <= staleClaimBefore)),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      return limit === undefined ? queued : queued.slice(0, limit);
    },
    insertIfAbsent: async (item) => rows.insertIfAbsent(item),
    update: async (id, apply) => rows.update(id, apply),
    async mutateMany(updates) {
      return updates.map(({ id, apply }) => {
        const current = rows.get(id);
        if (current) return rows.update(id, (item) => apply(item))!;
        rows.insertIfAbsent({ ...apply(null), id });
        return rows.get(id)!;
      });
    },
    async delete(ids) {
      for (const id of ids) rows.delete(id);
    },
    async deleteByLoop(loopId) {
      for (const item of rows.where((candidate) => candidate.loopId === loopId)) rows.delete(item.id);
    },
  };
}
