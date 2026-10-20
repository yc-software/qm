import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createNoopLeaderLease } from "../../src/persistence/leader-lease.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { createMemoryBlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import type { CommandApprovalGrant, PendingApprovalRecord } from "../../src/types.ts";

export const singleProcessDeps = () => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: createMemoryMap<PendingApprovalRecord>(),
  approvalGrants: createMemoryMap<CommandApprovalGrant>(),
  blobTransfer: createMemoryBlobTransferStore(),
});
