import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createNoopLeaderLease } from "../../src/persistence/leader-lease.ts";
import { createMemoryBlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import { createApprovalStore } from "../../src/core/approval-store.ts";
import { createApprovalGrantStore } from "../../src/core/approval-grant-store.ts";
import { createDeliveryStore } from "../../src/delivery/delivery-store.ts";

export const singleProcessDeps = () => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: createApprovalStore(createDeliveryStore()),
  approvalGrants: createApprovalGrantStore(),
  blobTransfer: createMemoryBlobTransferStore(),
});
