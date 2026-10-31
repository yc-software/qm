import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createNoopLeaderLease } from "../../src/persistence/leader-lease.ts";
import { createMemoryBlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import type { CommandApprovalGrant, PendingApprovalRecord } from "../../src/types.ts";
import { testMap } from "./test-database.ts";

export const singleProcessDeps = () => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: testMap<PendingApprovalRecord>(),
  approvalGrants: testMap<CommandApprovalGrant>(),
  blobTransfer: createMemoryBlobTransferStore(),
});
