import type { ApprovalGrantModes, PendingApproval, PendingApprovalRecord } from "../../types.ts";

export function grantModesWithin(
  allowed: ApprovalGrantModes,
  requested: ApprovalGrantModes | undefined,
): { grantModes?: ApprovalGrantModes } {
  const session = allowed.session && (requested?.session ?? true);
  const always = allowed.always && (requested?.always ?? true);
  return session && always ? {} : { grantModes: { session, always } };
}

export function approvalView(requestId: string, record: PendingApprovalRecord): PendingApproval {
  return {
    requestId,
    command: record.command,
    reason: record.reason ?? "requires approval",
    blocksInput: record.blocksInput !== false,
    ...(record.grantModes ? { grantModes: record.grantModes } : {}),
    ...(record.matched ? { matched: record.matched } : {}),
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.summaryDetail ? { summaryDetail: record.summaryDetail } : {}),
    ...(record.approvalKey ? { approvalKey: record.approvalKey } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
  };
}
