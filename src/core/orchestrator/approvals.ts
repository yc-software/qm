import type {
  ApprovalGrantModes,
  CommandApprovalGrant,
  PendingApproval,
  PendingApprovalRecord,
  ScopeId,
  TurnRequest,
  TurnResult,
} from "../../types.ts";
import type { Item, NewItem } from "../../sessions/items.ts";
import type { Lease } from "../../sessions/session-store.ts";
import { createPgPool } from "../../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../../persistence/typed-table.ts";
import type { ApprovalRecords } from "../approval-store.ts";
import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { rosterIds, samePerson } from "../../directory/person.ts";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { sleep } from "../../util/async.ts";
import { errMessage } from "../../util/errors.ts";
import { headSlice } from "../../util/text.ts";
import { approvalGrantId } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

const OPERATION_APPROVED_NOTE = loadProtocolFile("turn-approval-operation");
const OPERATION_DENIED_NOTE = loadProtocolFile("turn-approval-denied");

export interface ApprovalRequest {
  requestId: string;
  command: string;
  reason: string;
  blocksInput: boolean;
  grantModes?: ApprovalGrantModes;
  matched?: string;
  purpose?: string;
  summary?: string;
  summaryDetail?: string;
  approvalKey?: string;
  kind?: "approval" | "input";
}

function approvalView(
  requestId: string,
  record: PendingApprovalRecord,
  fallbackGrantModes?: ApprovalGrantModes,
): PendingApproval {
  const grantModes = record.grantModes ?? fallbackGrantModes;
  return {
    requestId,
    command: record.command,
    reason: record.reason ?? "requires approval",
    blocksInput: record.blocksInput !== false,
    ...(grantModes ? { grantModes } : {}),
    ...(record.matched ? { matched: record.matched } : {}),
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.summaryDetail ? { summaryDetail: record.summaryDetail } : {}),
    ...(record.approvalKey ? { approvalKey: record.approvalKey } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
  };
}

function effectiveGrantModes(
  admin: ApprovalGrantModes,
  requested: ApprovalGrantModes | undefined,
): ApprovalGrantModes | undefined {
  if (requested) return { session: admin.session && requested.session, always: admin.always && requested.always };
  return admin.session && admin.always ? undefined : admin;
}

export async function parkApprovals(
  store: Pick<ApprovalRecords, "put">,
  owner: { sessionId: string; request: TurnRequest; adminGrantModes: ApprovalGrantModes },
  requests: ApprovalRequest[],
): Promise<PendingApproval[]> {
  const views: PendingApproval[] = [];
  for (const r of requests) {
    const grantModes = effectiveGrantModes(owner.adminGrantModes, r.grantModes);
    const record: PendingApprovalRecord = {
      sessionId: owner.sessionId,
      command: r.command,
      createdAt: Date.now(),
      reason: r.reason,
      request: owner.request,
      blocksInput: r.blocksInput,
      ...(grantModes ? { grantModes } : {}),
      ...(r.matched ? { matched: r.matched } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.summaryDetail ? { summaryDetail: r.summaryDetail } : {}),
      ...(r.approvalKey ? { approvalKey: r.approvalKey } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
    };
    await store.put(r.requestId, record);
    views.push(approvalView(r.requestId, record));
  }
  return views;
}

export async function summarizeApproval(
  deps: Pick<OrchestratorDeps, "harness" | "approvalSummaryTimeoutMs" | "errors">,
  scopeId: ScopeId,
  command: string,
  reason: string,
  purpose?: string,
): Promise<string | undefined> {
  if (!deps.harness.models.summarizeApproval) return undefined;
  try {
    const summary = await Promise.race([
      deps.harness.models.summarizeApproval(command, reason, purpose),
      sleep(deps.approvalSummaryTimeoutMs ?? CONFIG_DEFAULTS.approvalSummaryTimeoutMs).then(() => undefined),
    ]);
    return summary?.trim() || undefined;
  } catch (e) {
    deps.errors?.record(
      {
        category: "command_policy",
        code: "summary_failed",
        message: errMessage(e),
        scopeLabel: scopeId,
      },
      e,
    );
    return undefined;
  }
}

export interface ApprovalLedger {
  consume(key: string): boolean;
  authorizeToolCall(tool: string): boolean;
  authorizeCommand(command: string, approvalKey?: string, exactApprovalKey?: boolean): boolean;
  credit(key: string, scope: "once" | "session" | "always"): void;
}

const APPROVAL_GRANTS: TableSpec = {
  table: "approval_grants",
  key: "id",
  columns: cols(`actorId text!, command text!, scope text!, createdAt bigint!, sessionId text, approvalKey text`),
};

const APPROVAL_GRANTS_MIGRATION = mapToTableMigration("core/approval-grants/0001-typed", APPROVAL_GRANTS, {
  statements: [`CREATE INDEX IF NOT EXISTS approval_grants_actor ON approval_grants (lower(btrim(actor_id)))`],
});

export function createApprovalGrants(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [APPROVAL_GRANTS_MIGRATION]);
  const { put, codec } = typedTable<CommandApprovalGrant>(pg, APPROVAL_GRANTS);
  return {
    put,
    async forActor(actorId: string): Promise<CommandApprovalGrant[]> {
      const keys = [...new Set(rosterIds(actorId).map((id) => id.toLowerCase()))];
      const rows = await pg.q(
        `SELECT ${codec.columns} FROM approval_grants WHERE lower(btrim(actor_id)) = ANY($1::text[]) ORDER BY id`,
        [keys],
      );
      return codec.rows(rows).filter((grant) => samePerson(grant.actorId, actorId));
    },
  };
}

export type ApprovalGrants = ReturnType<typeof createApprovalGrants>;

export function loadActorGrants(grants: ApprovalGrants, actorId: string): () => Promise<CommandApprovalGrant[]> {
  let loaded: Promise<CommandApprovalGrant[]> | undefined;
  return () => (loaded ??= grants.forActor(actorId));
}

export function loadApprovalLedger(
  actorGrants: CommandApprovalGrant[],
  sessionId: string,
  adminGrantModes: ApprovalGrantModes,
): ApprovalLedger {
  const uses = new Map<string, number>();
  for (const grant of actorGrants) {
    if (grant.scope === "session" && grant.sessionId !== sessionId) continue;
    if (!adminGrantModes[grant.scope]) continue;
    uses.set(grant.approvalKey ?? grant.command, Infinity);
  }
  const consume = (key: string): boolean => {
    const left = uses.get(key) ?? 0;
    if (left <= 0) return false;
    uses.set(key, left - 1);
    return true;
  };
  return {
    consume,
    authorizeToolCall: (tool) => consume(`tool:${tool}`),
    authorizeCommand: (command, approvalKey, exactApprovalKey = false) => {
      let key = approvalKey ?? command;
      if (approvalKey !== undefined && uses.has(approvalKey)) key = approvalKey;
      else if (!exactApprovalKey && uses.has(command)) key = command;
      return consume(key);
    },
    credit: (key, scope) => uses.set(key, (uses.get(key) ?? 0) + (scope === "once" ? 1 : Infinity)),
  };
}

export type ApprovalDecisionOutcome =
  | { kind: "settled"; result: TurnResult }
  | { kind: "approved"; approvalNote: string }
  | { kind: "denied"; approvalNote: string };

type DecidedScope = NonNullable<NonNullable<OrchestratorInput["approval"]>["scope"]>;

export async function consumeApprovalDecision(args: {
  deps: Pick<OrchestratorDeps, "approvals" | "approvalGrants" | "auditLog" | "sessions" | "sessionSyscalls">;
  decision: NonNullable<OrchestratorInput["approval"]>;
  sessionId: string;
  runId?: string;
  lease: Lease;
  actorId: string;
  scopeId: ScopeId;
  resolution: { approvalGrantModes: ApprovalGrantModes };
  ledger: ApprovalLedger;
  withRosterVersion: <T>(fn: () => Promise<T>) => Promise<T>;
  mirror: (item: Item) => Promise<void>;
}): Promise<ApprovalDecisionOutcome> {
  const { deps, decision, sessionId, lease, actorId, scopeId, resolution } = args;
  const requestId = decision.requestId;
  const settled = (result: TurnResult): ApprovalDecisionOutcome => ({ kind: "settled", result });
  const audit = (action: string, resource: string, status: string, detail?: Record<string, unknown>) =>
    deps.auditLog.record({
      at: Date.now(),
      principalId: actorId,
      action,
      resource,
      scopeLabel: scopeId,
      status,
      ...(detail ? { detail: JSON.stringify(detail) } : {}),
    });
  const denied = (command: string): ApprovalDecisionOutcome => {
    audit("command_approval.deny", command, "refused", { approvalOutcome: "denied" });
    return { kind: "denied", approvalNote: OPERATION_DENIED_NOTE };
  };
  const approved = async (command: string, scope: DecidedScope, approvalKey?: string) => {
    args.ledger.credit(approvalKey ?? command, scope);
    if (scope === "session" || scope === "always") {
      const grant: CommandApprovalGrant = {
        actorId,
        command,
        scope,
        createdAt: Date.now(),
        ...(approvalKey ? { approvalKey } : {}),
        ...(scope === "session" ? { sessionId } : {}),
      };
      await deps.approvalGrants.put(approvalGrantId(grant), grant);
    }
    audit(`command_approval.${scope}`, command, "ok");
    return { kind: "approved" as const, approvalNote: OPERATION_APPROVED_NOTE };
  };
  const recorded = args.runId
    ? (await deps.sessions.getItems(sessionId, { turnId: args.runId })).find(
        (e) => e.kind === "ElicitationResponse" && e.elicitId === requestId,
      )
    : undefined;
  if (recorded) {
    await deps.approvals.delete(requestId);
    const command = String(recorded.body.command);
    if (!recorded.approved) return denied(command);
    const approvalKey = typeof recorded.body.approvalKey === "string" ? recorded.body.approvalKey : undefined;
    return approved(command, (recorded.body.scope as DecidedScope | undefined) ?? "once", approvalKey);
  }
  const p = await deps.approvals.get(requestId);
  const verb = decision.approved ? "approve" : "deny";
  const expired = (outcome: "expired" | "foreign_session") => {
    audit(`command_approval.${verb}`, requestId, "refused", { approvalOutcome: outcome });
    return settled({
      status: "refused",
      sessionId,
      reason: "that approval request expired — ask again if you still want it to run",
    });
  };
  if (!p || p.sessionId !== sessionId) return expired(p ? "foreign_session" : "expired");
  const requesterId = p.request?.actor.externalId;
  if (!samePerson(requesterId, actorId)) {
    audit(`command_approval.${verb}`, p.command, "refused", {
      approvalOutcome: "not_requester",
      requesterId: requesterId ?? null,
    });
    return settled({
      status: "refused",
      sessionId,
      reason: "only the person who requested this command can approve or deny it",
    });
  }
  const scope = decision.scope ?? "once";
  if (decision.approved && scope !== "once") {
    const recordDisallowsScope = p.grantModes?.[scope] === false;
    if (!resolution.approvalGrantModes[scope] || recordDisallowsScope) {
      let reason = `the "${scope}" approval option is disabled by an admin here — approve once or deny`;
      if (recordDisallowsScope && resolution.approvalGrantModes[scope])
        reason = `this approval does not allow the "${scope}" option — approve once or deny`;
      audit(`command_approval.${scope}`, p.command, "refused", { approvalOutcome: "grant_mode_disabled" });
      return settled({
        status: "pending_approval",
        sessionId,
        reason,
        pendingApprovals: [approvalView(requestId, p, resolution.approvalGrantModes)],
      });
    }
  }
  const response: NewItem = {
    kind: "ElicitationResponse",
    elicitId: requestId,
    approved: decision.approved,
    author: actorId,
    body: decision.approved
      ? { command: p.command, scope, ...(p.approvalKey ? { approvalKey: p.approvalKey } : {}) }
      : { command: p.command },
  };
  const items: NewItem[] = decision.approved
    ? [response]
    : [
        response,
        {
          kind: "UserMessage",
          hidden: true,
          body: { approvalDenial: true },
          text: `The requesting human denied this pending operation, so it did not run: ${headSlice(p.summary ?? p.command, 2_000)}\nContinue without it. You need not address the denial. Do not retry it unless they ask again.`,
        },
      ];
  const [written] = await args.withRosterVersion(() => deps.sessions.appendMany(lease, items));
  if (!(await deps.approvals.take(requestId))) return expired("expired");
  await args.mirror(written!);
  if (!decision.approved) return denied(p.command);
  return approved(p.command, scope, p.approvalKey);
}
