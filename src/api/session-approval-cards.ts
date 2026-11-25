import { personIds, samePerson } from "../directory/person.ts";
import { approvalView } from "../core/orchestrator/approvals.ts";
import type { PendingApproval, PendingApprovalRecord } from "../types.ts";
import type { ApiCtx } from "./routes/route.ts";

async function credentialApprovals(ctx: ApiCtx, sessionId: string, viewer: string): Promise<PendingApproval[]> {
  const kc = ctx.deps.keychain;
  const approvals = ctx.deps.keychainApprovals;
  if (!kc || !approvals) return [];
  const out: PendingApproval[] = [];
  for (const ask of await kc.listAsks({ ownerId: viewer })) {
    if (ask.status !== "pending") continue;
    const view = await approvals.get(ask.id, viewer);
    if (!view || (view.sessionId !== sessionId && view.requesterSessionId !== sessionId)) continue;
    out.push({
      requestId: `keychain:${ask.id}`,
      command: view.accountLabel ? `${view.service} (${view.accountLabel})` : view.service,
      summary: `Use your ${view.service} credential in ${view.conversation}`,
      reason: "Credential approval",
      grantModes: { session: false, always: true },
      blocksInput: false,
    });
  }
  return out;
}

async function homeDmApprovals(ctx: ApiCtx, sessionId: string, viewer: string): Promise<PendingApproval[]> {
  const { sessions, approvals } = ctx.deps;
  if (!sessions || !approvals) return [];
  const session = await sessions.get(sessionId);
  if (!session || !personIds(viewer).some((id) => session.threadRef === `web:${id}:direct`)) return [];
  const homed = await approvals.selectEntries({ where: { field: "cardTo", anyOfFold: [viewer] } });
  return homed
    .filter(([, record]) => samePerson(record.cardTo, viewer) && record.sessionId !== sessionId)
    .map(([id, record]) => approvalView(id, record as PendingApprovalRecord));
}

export async function cardsShownInSession(ctx: ApiCtx, sessionId: string, viewer: string): Promise<PendingApproval[]> {
  return [...(await credentialApprovals(ctx, sessionId, viewer)), ...(await homeDmApprovals(ctx, sessionId, viewer))];
}
