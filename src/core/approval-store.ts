import { swallowAs } from "../util/errors.ts";
import { pgJsonText, pgTextSafe } from "../util/text.ts";
import type { PendingApprovalRecord } from "../types.ts";
import { currentTenant } from "../tenants/context.ts";
import { createPgPool, type Rows } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { principalDestination } from "../reach/reach.ts";

export interface ApprovalStore {
  get(id: string): Promise<PendingApprovalRecord | null>;
  put(id: string, record: PendingApprovalRecord): Promise<void>;
  delete(id: string): Promise<void>;
  forSessions(sessionIds: readonly string[]): Promise<Array<[string, PendingApprovalRecord]>>;
  blockingSessionIds(): Promise<string[]>;
  deliverPending(): Promise<void>;
  close?(): Promise<void>;
}

type ApprovalRows = Omit<ApprovalStore, "deliverPending"> & {
  slackPending(): Promise<Array<[string, PendingApprovalRecord]>>;
};

const APPROVALS_MIGRATION = typedTableMigration({
  table: "approvals",
  columns: [
    "id TEXT NOT NULL",
    "session_id TEXT NOT NULL",
    "command TEXT NOT NULL",
    "created_at BIGINT",
    "reason TEXT",
    "matched TEXT",
    "purpose TEXT",
    "summary TEXT",
    "summary_detail TEXT",
    "approval_key TEXT",
    "grant_session BOOLEAN",
    "grant_always BOOLEAN",
    "request JSONB",
    "screened_output JSONB",
    "blocks_input BOOLEAN",
    "kind TEXT CHECK (kind IN ('approval', 'input'))",
  ],
  primaryKey: ["id"],
  backfill: {
    id: "id",
    session_id: "json->>'sessionId'",
    command: "json->>'command'",
    created_at: "(json->>'createdAt')::numeric::bigint",
    reason: "json->>'reason'",
    matched: "json->>'matched'",
    purpose: "json->>'purpose'",
    summary: "json->>'summary'",
    summary_detail: "json->>'summaryDetail'",
    approval_key: "json->>'approvalKey'",
    grant_session: "(json->'grantModes'->>'session')::boolean",
    grant_always: "(json->'grantModes'->>'always')::boolean",
    request: "json->'request'",
    screened_output: "json->'screenedOutput'",
    blocks_input: "(json->>'blocksInput')::boolean",
    kind: "CASE WHEN json->>'kind' IN ('approval', 'input') THEN json->>'kind' END",
  },
  where: "json->>'sessionId' IS NOT NULL AND json->>'command' IS NOT NULL",
  indexes: ["CREATE INDEX approvals_by_session ON approvals(tenant_id, session_id)"],
});

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

function withDelivery(rows: ApprovalRows, deliveries: Pick<DeliveryStore, "enqueue">): ApprovalStore {
  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    if (record.request?.surface !== "slack") return;
    const actorId = approvalDeliveryRecipient(record.request.actor);
    if (!actorId) return;
    const threadTs = record.request.conversation?.kind === "dm" ? record.request.slackSource?.replyThreadTs : undefined;
    await deliveries.enqueue({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...(record.request.slackSource
          ? { slackAccountId: record.request.slackSource.accountId, slackTeamId: record.request.slackSource.teamId }
          : {}),
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  const { slackPending, ...store } = rows;
  return {
    ...store,
    async put(id, record) {
      await rows.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: enqueue delivery", undefined));
    },
    async deliverPending() {
      for (const [id, record] of await slackPending()) await deliver(id, record);
    },
  };
}

export function createApprovalStore(deliveries: Pick<DeliveryStore, "enqueue">): ApprovalStore {
  const byTenant = new Map<string, Map<string, PendingApprovalRecord>>();
  const rows = () => {
    const tenant = currentTenant();
    return byTenant.get(tenant) ?? byTenant.set(tenant, new Map()).get(tenant)!;
  };
  const matching = (keep: (r: PendingApprovalRecord) => boolean) =>
    [...rows()].filter(([, r]) => keep(r)).sort(([a], [b]) => a.localeCompare(b));
  return withDelivery(
    {
      get: async (id) => rows().get(id) ?? null,
      put: async (id, record) => void rows().set(id, record),
      delete: async (id) => void rows().delete(id),
      async forSessions(ids) {
        const wanted = new Set(ids);
        return matching((r) => wanted.has(r.sessionId));
      },
      async blockingSessionIds() {
        return [...new Set(matching((r) => r.blocksInput !== false).map(([, r]) => r.sessionId))];
      },
      slackPending: async () => matching((r) => r.request?.surface === "slack"),
    },
    deliveries,
  );
}

const COLUMNS = `id, session_id, command, created_at, reason, matched, purpose, summary, summary_detail, approval_key,
  grant_session, grant_always, request, screened_output, blocks_input, kind`;

function fromRow(row: Rows[number]): PendingApprovalRecord {
  const text = (column: string) => (row[column] == null ? undefined : String(row[column]));
  const optional = {
    createdAt: row.created_at == null ? undefined : Number(row.created_at),
    reason: text("reason"),
    matched: text("matched"),
    purpose: text("purpose"),
    summary: text("summary"),
    summaryDetail: text("summary_detail"),
    approvalKey: text("approval_key"),
    grantModes:
      row.grant_session == null && row.grant_always == null
        ? undefined
        : { session: row.grant_session === true, always: row.grant_always === true },
    request: (row.request ?? undefined) as PendingApprovalRecord["request"],
    blocksInput: row.blocks_input == null ? undefined : row.blocks_input === true,
    kind: (row.kind ?? undefined) as PendingApprovalRecord["kind"],
  };
  return {
    ...(row.screened_output == null
      ? {}
      : { screenedOutput: row.screened_output as NonNullable<PendingApprovalRecord["screenedOutput"]> }),
    sessionId: String(row.session_id),
    command: String(row.command),
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}

function toParams(id: string, r: PendingApprovalRecord): unknown[] {
  const text = (value: string | undefined) => (value === undefined ? null : pgTextSafe(value));
  const json = (value: unknown) => (value === undefined ? null : pgJsonText(value));
  return [
    id,
    pgTextSafe(r.sessionId),
    pgTextSafe(r.command),
    r.createdAt ?? null,
    text(r.reason),
    text(r.matched),
    text(r.purpose),
    text(r.summary),
    text(r.summaryDetail),
    text(r.approvalKey),
    r.grantModes?.session ?? null,
    r.grantModes?.always ?? null,
    json(r.request),
    json(r.screenedOutput),
    r.blocksInput ?? null,
    r.kind ?? null,
  ];
}

export function createPostgresApprovalStore(
  connectionString: string,
  deliveries: Pick<DeliveryStore, "enqueue">,
): ApprovalStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, APPROVALS_MIGRATION]);
  const entries = (rows: Rows): Array<[string, PendingApprovalRecord]> =>
    rows.map((row) => [String(row.id), fromRow(row)]);
  const store = withDelivery(
    {
      async get(id) {
        const rows = await q(`SELECT ${COLUMNS} FROM approvals WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
        return rows[0] ? fromRow(rows[0]) : null;
      },
      async put(id, record) {
        await q(
          `INSERT INTO approvals(${COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16)
           ON CONFLICT (tenant_id, id) DO UPDATE SET
             session_id = EXCLUDED.session_id, command = EXCLUDED.command, created_at = EXCLUDED.created_at,
             reason = EXCLUDED.reason, matched = EXCLUDED.matched, purpose = EXCLUDED.purpose,
             summary = EXCLUDED.summary, summary_detail = EXCLUDED.summary_detail,
             approval_key = EXCLUDED.approval_key, grant_session = EXCLUDED.grant_session,
             grant_always = EXCLUDED.grant_always, request = EXCLUDED.request,
             screened_output = EXCLUDED.screened_output, blocks_input = EXCLUDED.blocks_input, kind = EXCLUDED.kind`,
          toParams(id, record),
        );
      },
      async delete(id) {
        await q(`DELETE FROM approvals WHERE tenant_id = ${TENANT} AND id = $1`, [id]);
      },
      async forSessions(sessionIds) {
        if (!sessionIds.length) return [];
        return entries(
          await q(
            `SELECT ${COLUMNS} FROM approvals WHERE tenant_id = ${TENANT} AND session_id = ANY($1::text[]) ORDER BY id`,
            [sessionIds],
          ),
        );
      },
      async blockingSessionIds() {
        const rows = await q(
          `SELECT DISTINCT session_id FROM approvals
            WHERE tenant_id = ${TENANT} AND blocks_input IS DISTINCT FROM false`,
        );
        return rows.map((row) => String(row.session_id));
      },
      async slackPending() {
        return entries(
          await q(
            `SELECT ${COLUMNS} FROM approvals WHERE tenant_id = ${TENANT} AND request->>'surface' = 'slack' ORDER BY id`,
          ),
        );
      },
    },
    deliveries,
  );
  return { ...store, close };
}
