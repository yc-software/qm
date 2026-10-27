import { surfaceHas } from "../surfaces/surface.ts";
import { swallowAs } from "../util/errors.ts";
import { type PendingApprovalRecord, sourceDestination, type TurnRequest, turnSource } from "../types.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import {
  cols,
  retireJsonKeysMigration,
  mapToTableMigration,
  type TableSpec,
  typedTable,
} from "../persistence/typed-table.ts";
import type { SurfaceRegistry } from "../surfaces/registry.ts";
import type { Outbound } from "../surfaces/outbound.ts";
import { principalDestination } from "../reach/reach.ts";

export function approvalDeliveryKey(id: string, record: Pick<PendingApprovalRecord, "createdAt">): string {
  return `command-approval:${id}:${record.createdAt ?? 0}`;
}

export function approvalDeliveryRecipient(actor: { externalId?: string } | undefined): string | undefined {
  const id = actor?.externalId;
  return id && !id.startsWith("system:") ? id : undefined;
}

const APPROVALS: TableSpec = {
  table: "approvals",
  key: "id",
  columns: cols(`sessionId text!, command text!, createdAt bigint, reason text, matched text, purpose text,
    summary text, summaryDetail text, approvalKey text, grantModes jsonb, request jsonb,
    blocksInput boolean, kind text`),
};

export const APPROVALS_MIGRATION = mapToTableMigration("core/approvals/0001-typed", APPROVALS, {
  statements: [`CREATE INDEX IF NOT EXISTS approvals_session ON approvals (session_id)`],
});

export function createApprovalRecords(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [
    retireJsonKeysMigration("core/approvals/0000-drop-screened-output", "approvals", { drop: ["screenedOutput"] }),
    APPROVALS_MIGRATION,
  ]);
  const { get, put, delete: remove, take, codec } = typedTable<PendingApprovalRecord>(pg, APPROVALS);
  const entries = (rows: Record<string, unknown>[]): Array<[string, PendingApprovalRecord]> =>
    rows.map((r) => [String(r.id), codec.row(r)]);
  return {
    get,
    put,
    delete: remove,
    take,
    async entries(): Promise<Array<[string, PendingApprovalRecord]>> {
      return entries(await pg.q(`SELECT ${codec.columns} FROM approvals ORDER BY id`));
    },
    async forSessions(sessionIds: readonly string[]): Promise<Array<[string, PendingApprovalRecord]>> {
      if (!sessionIds.length) return [];
      return entries(
        await pg.q(`SELECT ${codec.columns} FROM approvals WHERE session_id = ANY($1::text[]) ORDER BY id`, [
          [...sessionIds],
        ]),
      );
    },
    async blockingSessionIds(): Promise<string[]> {
      const rows = await pg.q(`SELECT DISTINCT session_id FROM approvals WHERE blocks_input IS NOT FALSE`);
      return rows.map((r) => String(r.session_id));
    },
  };
}

export type ApprovalRecords = ReturnType<typeof createApprovalRecords>;

export function createApprovalStore(
  backing: ApprovalRecords,
  outbound: Pick<Outbound, "send">,
  opts: { surfaces?: Pick<SurfaceRegistry, "get">; webSessionUrl?: (sessionId: string) => string | undefined } = {},
) {
  async function deliverText(id: string, record: PendingApprovalRecord, request: TurnRequest): Promise<void> {
    if (!request.deliveryTarget) return;
    const url = record.sessionId ? opts.webSessionUrl?.(record.sessionId) : undefined;
    await outbound.send({
      destination: { type: request.surface, target: request.deliveryTarget, ...sourceDestination(turnSource(request)) },
      text: [
        `Approval needed: ${record.summary ?? record.command}`,
        url ? `Approve or deny it here: ${url}` : "Approve or deny it in the web app.",
      ].join("\n"),
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }

  async function deliver(id: string, record: PendingApprovalRecord): Promise<void> {
    const request = record.request;
    if (!request?.surface) return;
    if (!surfaceHas(request.surface, "nativeApprovals")) {
      if (opts.surfaces?.get(request.surface)) await deliverText(id, record, request);
      return;
    }
    const actorId = approvalDeliveryRecipient(request.actor);
    if (!actorId) return;
    const source = turnSource(request);
    const threadTs = request.conversation?.kind === "dm" ? source?.replyThread : undefined;
    await outbound.send({
      destination: {
        ...principalDestination(actorId, actorId),
        commandApprovalId: id,
        ...(threadTs ? { threadTs } : {}),
        ...(source ? { account: source.account, workspaceId: source.workspaceId } : {}),
      },
      text: `Approval needed: ${record.summary ?? record.command}`,
      idempotencyKey: approvalDeliveryKey(id, record),
    });
  }
  return {
    ...backing,
    async put(id: string, record: PendingApprovalRecord): Promise<void> {
      await backing.put(id, record);
      await deliver(id, record).catch(swallowAs("approvals: post approval request (the sweep retries)", undefined));
    },
    async deliverPending(): Promise<void> {
      for (const [id, record] of await backing.entries())
        await deliver(id, record).catch(swallowAs("approvals: post approval request (the sweep retries)", undefined));
    },
  };
}
