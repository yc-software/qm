import { type PgPool, type PoolClient, withPgTransaction } from "../persistence/pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";
import type { GoalRecord } from "../agent/goal.ts";
import type { GetItemsOptions, SessionStore, SessionWriter } from "./session-store.ts";
import { DuplicateCallError, userMessagePreview } from "./session-store.ts";
import { ITEM_COLUMNS, type Item, isUserItem, msOf, type NewItem, storedItem, TENANT, userTurn } from "./items.ts";

function rowToGoal(r: Record<string, unknown>): GoalRecord {
  return {
    objective: r.objective as string,
    status: r.status as GoalRecord["status"],
    tokensUsed: Number(r.tokens_used),
    createdAt: (r.created_at as Date).getTime(),
    updatedAt: (r.updated_at as Date).getTime(),
    ...(r.floor != null ? { floor: r.floor as GoalRecord["floor"] } : {}),
    ...(r.token_cap != null ? { capTokens: Number(r.token_cap) } : {}),
    ...(r.active_ms != null ? { activeMs: Number(r.active_ms) } : {}),
    ...(r.active_since != null ? { activeSince: (r.active_since as Date).getTime() } : {}),
    ...(r.completion_note != null ? { completionNote: r.completion_note as string } : {}),
    ...(r.cancel_note != null ? { cancelNote: r.cancel_note as string } : {}),
    ...(r.governor != null ? { governor: r.governor as GoalRecord["governor"] } : {}),
    ...(r.pause_reason != null ? { pauseReason: r.pause_reason as string } : {}),
  };
}

function rowToItem(r: Record<string, unknown>): Item {
  return {
    sessionId: r.session_id as string,
    seq: Number(r.seq),
    createdAt: Number(r.created_at),
    ...Object.fromEntries(
      ITEM_COLUMNS.map(([, key, type]) => [
        key,
        type === "bigint" && r[key] != null ? Number(r[key]) : (r[key] ?? null),
      ]),
    ),
  } as Item;
}

const ITEM_FIELDS = `i.session_id, i.seq, ${ITEM_COLUMNS.map(([column, key]) => `${column === "blob_sha" ? "encode(i.blob_sha, 'hex')" : `i.${column}`} AS "${key}"`).join(",")}, ${msOf("i.created_at")} AS created_at`;
const ITEM_FROM = "items i";
const tsOf = (ms: string): string => `to_timestamp((${ms})::double precision / 1000)`;

const LAST_ACTIVITY_DEBOUNCE_MS = 60_000;
const FIRST_PREVIEW_LEN = 160;
const LAST_PREVIEW_LEN = 100;
const storedPreview = (item: Item, maxLen: number): string => pgTextSafe(userMessagePreview(item.text ?? "", maxLen));

export const lockSession = (client: PoolClient, sessionId: string) =>
  client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);

function transcriptItemPredicate(alias: string): string {
  const receipt = (item: string): string => `COALESCE(${item}.body @> '{"slackReplyReceipt":true}'::jsonb, false)`;
  return `NOT (
    ${alias}.kind = 'UserMessage' AND ${receipt(alias)}
    AND (
      SELECT 1 FROM items received
      WHERE received.tenant_id = ${alias}.tenant_id AND received.session_id = ${alias}.session_id
        AND received.kind = 'UserMessage' AND received.external_id = ${alias}.external_id
        AND NOT ${receipt("received")}
      LIMIT 1
    ) IS NOT NULL
  )`;
}

export function createSessionItems(deps: {
  db: PgPool;
  now: () => number;
}): Pick<
  SessionStore,
  | "append"
  | "appendMany"
  | "countItemsBefore"
  | "latestToolSteps"
  | "latestItemSeq"
  | "goals"
  | "setGoal"
  | "hasDeliveryEntry"
  | "getItems"
  | "userItemSeqs"
  | "getContextWindow"
  | "getItem"
  | "visibleItems"
  | "latestVisiblePromptAt"
> {
  const { db, now } = deps;
  const { pool, q } = db;

  const readItems = async (sessionId: string, opts?: GetItemsOptions, principalId?: string): Promise<Item[]> => {
    const params: unknown[] = [sessionId, opts?.sinceSeq ?? 0];
    let sql = `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM}`;
    if (principalId !== undefined) {
      params.push(principalId);
      sql += ` JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $${params.length}`;
    }
    sql += ` WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2`;
    if (opts?.seqs) {
      if (!opts.seqs.length) return [];
      params.push(opts.seqs);
      sql += ` AND i.seq = ANY($${params.length}::bigint[])`;
    }
    if (opts?.messagesOnly)
      sql += " AND i.kind IN ('UserMessage', 'SteeringMessage', 'AgentMessage') AND i.variant IS NULL";
    if (opts?.transcript) sql += ` AND ${transcriptItemPredicate("i")}`;
    if (opts?.beforeSeq !== undefined) {
      params.push(opts.beforeSeq);
      sql += ` AND i.seq < $${params.length}`;
    }
    if (opts?.turnId !== undefined) {
      params.push(opts.turnId);
      sql += ` AND i.turn_id = $${params.length}::uuid`;
    }
    sql += " ORDER BY i.seq DESC";
    if (opts?.limit !== undefined) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }
    return (await q(sql, params)).map(rowToItem).reverse();
  };

  const withSessionLock = async <T>(writer: SessionWriter, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withPgTransaction(await pool(), async (client) => {
      await lockSession(client, writer.sessionId);
      if (writer.turnId && writer.runLeaseToken) {
        const held = await client.query(
          "SELECT 1 FROM runs WHERE id = $1 AND lease_token = $2 AND status = 'running' FOR SHARE",
          [writer.turnId, writer.runLeaseToken],
        );
        if (!held.rowCount) throw new Error(`run ${writer.turnId} no longer holds its claim; write refused`);
      }
      return fn(client);
    });

  const insertItems = async (
    client: PoolClient,
    sessionId: string,
    entries: readonly NewItem[],
    turnId?: string,
  ): Promise<Item[]> => {
    if (!entries.length) return [];
    const max = await client.query(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(seq) FROM items WHERE tenant_id = ${TENANT} AND session_id = $1), -1) + 1,
         COALESCE((SELECT messages FROM sessions WHERE id = $1), 0)) AS n`,
      [sessionId],
    );
    const startSeq = Number(max.rows[0]!.n);
    const createdAt = now();
    const items = entries.map((entry, index) =>
      storedItem(JSON.parse(jsonbStringify(entry)) as NewItem, { sessionId, seq: startSeq + index, createdAt, turnId }),
    );
    const userTurns = items.filter((item) => isUserItem(item) && item.body.overheard !== true);
    const firstUser = userTurns[0];
    const lastUser = userTurns[userTurns.length - 1];
    await client
      .query(
        `WITH inserted AS (
           INSERT INTO items(tenant_id, session_id, seq, ${ITEM_COLUMNS.map(([column]) => column).join(",")}, created_at)
           SELECT ${TENANT}, $1, i.seq, ${ITEM_COLUMNS.map(([column, key]) => (column === "blob_sha" ? `decode(i."${key}", 'hex')` : `i."${key}"`)).join(",")}, ${tsOf("$2::bigint")}
           FROM jsonb_to_recordset($9::jsonb) AS i(seq bigint, ${ITEM_COLUMNS.map(([, key, type]) => `"${key}" ${type}`).join(",")})
           ORDER BY i.seq)
         UPDATE sessions
            SET last_activity = CASE WHEN last_activity >= $2::bigint - ${LAST_ACTIVITY_DEBOUNCE_MS}
                                     THEN last_activity
                                     ELSE GREATEST(COALESCE(last_activity, 0), $2::bigint) END,
                messages = $3,
                turns = CASE WHEN turns IS NULL OR messages IS DISTINCT FROM $5
                             THEN (SELECT COUNT(*) FROM items t WHERE t.tenant_id = ${TENANT} AND t.session_id = $1 AND ${userTurn("t")}) + $4
                             ELSE turns + $4 END,
                first_user_preview = CASE WHEN first_user_preview IS NULL AND turns = 0 AND messages = $5
                                          THEN $6 ELSE first_user_preview END,
                last_user_preview = COALESCE($7, last_user_preview),
                last_user_activity = CASE WHEN $8::boolean THEN GREATEST(COALESCE(last_user_activity, 0), $2::bigint)
                                          ELSE last_user_activity END
          WHERE id = $1`,
        [
          sessionId,
          createdAt,
          startSeq + items.length,
          userTurns.length,
          startSeq,
          firstUser ? storedPreview(firstUser, FIRST_PREVIEW_LEN) : null,
          lastUser ? storedPreview(lastUser, LAST_PREVIEW_LEN) : null,
          items.some(isUserItem),
          jsonbStringify(items),
        ],
      )
      .catch((err: unknown) => {
        const e = err as { code?: unknown; constraint?: unknown };
        if (e?.code !== "23505" || e.constraint !== "items_one_call_per_kind") throw err;
        throw new DuplicateCallError(
          sessionId,
          items.flatMap((item) => (item.callId ? [item.callId] : [])),
          { cause: err },
        );
      });
    return items;
  };

  return {
    async append(writer: SessionWriter, item: NewItem): Promise<Item> {
      return (await this.appendMany(writer, [item]))[0]!;
    },

    async appendMany(writer: SessionWriter, items: readonly NewItem[]): Promise<Item[]> {
      return withSessionLock(writer, (client) => insertItems(client, writer.sessionId, items, writer.turnId));
    },

    async countItemsBefore(sessionId, beforeSeq, principalId) {
      const rows =
        principalId === undefined
          ? await q(
              `SELECT count(*)::int AS n FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i")}`,
              [sessionId, beforeSeq],
            )
          : await q(
              `SELECT count(*)::int AS n FROM items i
                 JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $3
                WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq < $2 AND ${transcriptItemPredicate("i")}`,
              [sessionId, beforeSeq, principalId],
            );
      return Number(rows[0]?.n ?? 0);
    },

    async latestToolSteps(turnIds) {
      if (!turnIds.length) return new Map();
      const rows = await q(
        `SELECT t.id::text AS turn_id, s.tool, ${msOf("s.created_at")} AS at, p.purpose
           FROM unnest($1::uuid[]) AS t(id)
           CROSS JOIN LATERAL (SELECT tool, created_at FROM items WHERE tenant_id = ${TENANT} AND turn_id = t.id
                                 AND kind IN ('ToolCall', 'ToolResult') ORDER BY seq DESC LIMIT 1) s
           LEFT JOIN LATERAL (SELECT btrim(body->>'purpose') AS purpose FROM items WHERE tenant_id = ${TENANT}
                                AND turn_id = t.id AND kind = 'ToolCall' AND btrim(body->>'purpose') <> ''
                              ORDER BY seq DESC LIMIT 1) p ON true`,
        [[...new Set(turnIds.map((id) => id.toLowerCase()))]],
      );
      return new Map(
        rows.map((r) => [
          String(r.turn_id),
          { tool: String(r.tool ?? ""), at: Number(r.at), ...(r.purpose ? { purpose: String(r.purpose) } : {}) },
        ]),
      );
    },

    async latestItemSeq(sessionId): Promise<number> {
      const rows = await q(
        `SELECT COALESCE(MAX(seq), -1) AS n FROM items WHERE tenant_id = ${TENANT} AND session_id = $1`,
        [sessionId],
      );
      return Number(rows[0]?.n ?? -1);
    },

    async goals(sessionIds) {
      const found = new Map<string, GoalRecord>();
      if (!sessionIds.length) return found;
      const rows = await q("SELECT * FROM session_goals WHERE session_id = ANY($1::text[])", [[...sessionIds]]);
      for (const row of rows) found.set(row.session_id as string, rowToGoal(row));
      return found;
    },

    async setGoal(writer, goal, notices = []) {
      await withSessionLock(writer, async (client) => {
        await insertItems(client, writer.sessionId, notices, writer.turnId);
        await client.query(
          `INSERT INTO session_goals(session_id, objective, status, floor, token_cap, tokens_used, active_ms,
                                     active_since, completion_note, cancel_note, governor, pause_reason,
                                     created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
           ON CONFLICT (tenant_id, session_id) DO UPDATE SET
             objective = EXCLUDED.objective, status = EXCLUDED.status, floor = EXCLUDED.floor,
             token_cap = EXCLUDED.token_cap, tokens_used = EXCLUDED.tokens_used, active_ms = EXCLUDED.active_ms,
             active_since = EXCLUDED.active_since, completion_note = EXCLUDED.completion_note,
             cancel_note = EXCLUDED.cancel_note, governor = EXCLUDED.governor, pause_reason = EXCLUDED.pause_reason,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
           WHERE session_goals.status NOT IN ('complete', 'cancelled')
              OR session_goals.created_at IS DISTINCT FROM EXCLUDED.created_at`,
          [
            writer.sessionId,
            goal.objective,
            goal.status,
            goal.floor ? JSON.stringify(goal.floor) : null,
            goal.capTokens ?? null,
            Math.floor(goal.tokensUsed),
            goal.activeMs === undefined ? null : Math.round(goal.activeMs),
            goal.activeSince === undefined ? null : new Date(goal.activeSince),
            goal.completionNote ?? null,
            goal.cancelNote ?? null,
            goal.governor ? JSON.stringify(goal.governor) : null,
            goal.pauseReason ?? null,
            new Date(goal.createdAt),
            new Date(goal.updatedAt),
          ],
        );
      });
    },

    async hasDeliveryEntry(sessionId, deliveryKey, slackTs) {
      const rows = await q(
        `SELECT 1 FROM items WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'UserMessage'
         AND (body ->> 'deliveryKey' = $2 OR external_id = $3) LIMIT 1`,
        [sessionId, deliveryKey, slackTs ?? null],
      );
      return rows.length > 0;
    },

    async userItemSeqs(ranges) {
      if (!ranges.length) return [];
      return (
        await q(
          `SELECT i.session_id, i.seq FROM items i
        JOIN jsonb_to_recordset($1::jsonb) AS wanted("sessionId" text, "sinceSeq" bigint)
          ON i.session_id = wanted."sessionId" AND i.seq >= wanted."sinceSeq"
        WHERE i.tenant_id = ${TENANT} AND i.kind IN ('UserMessage', 'SteeringMessage')
          AND ${transcriptItemPredicate("i")}`,
          [JSON.stringify(ranges)],
        )
      ).map((row) => ({ sessionId: row.session_id as string, seq: Number(row.seq) }));
    },

    getItems: (sessionId, opts) => readItems(sessionId, opts),

    async getContextWindow(sessionId) {
      const [meta, summary] = await Promise.all([
        q(`SELECT count(*)::int AS total FROM items i WHERE i.tenant_id = ${TENANT} AND i.session_id = $1`, [
          sessionId,
        ]),
        q(
          `SELECT through_seq AS through FROM items
            WHERE tenant_id = ${TENANT} AND session_id = $1 AND kind = 'ContextCompaction'
              AND through_seq IS NOT NULL AND text IS NOT NULL ORDER BY seq DESC LIMIT 1`,
          [sessionId],
        ),
      ]);
      const sinceSeq = summary[0]?.through == null ? 0 : Number(summary[0].through) + 1;
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq >= $2 ORDER BY i.seq`,
        [sessionId, sinceSeq],
      );
      return { items: rows.map(rowToItem), totalItems: Number(meta[0]?.total ?? 0) };
    },

    async getItem(sessionId, seq): Promise<Item | undefined> {
      const rows = await q(
        `SELECT ${ITEM_FIELDS} FROM ${ITEM_FROM} WHERE i.tenant_id = ${TENANT} AND i.session_id = $1 AND i.seq = $2`,
        [sessionId, seq],
      );
      return rows[0] ? rowToItem(rows[0]) : undefined;
    },

    async latestVisiblePromptAt(sessionId, principalId) {
      const rows = await q(
        `SELECT ${msOf("i.created_at")} AS at FROM items i
         JOIN participants p ON p.session_id = i.session_id AND p.principal_id = $2
         WHERE i.tenant_id = ${TENANT} AND i.session_id = $1
           AND i.kind IN ('UserMessage', 'SteeringMessage') AND i.hidden IS DISTINCT FROM true
           AND NOT (i.body @> '{"overheard":true}')
           AND (i.body->>'speakerId' IS NOT NULL OR i.body @> '{"slackReplyReceipt":true}'
             OR (i.kind = 'SteeringMessage' AND i.author IS NOT NULL))
           AND ${transcriptItemPredicate("i")}
         ORDER BY i.seq DESC LIMIT 1`,
        [sessionId, principalId],
      );
      return rows[0] ? Number(rows[0].at) : undefined;
    },

    visibleItems: (sessionId, principalId, opts) => readItems(sessionId, opts, principalId),
  };
}
