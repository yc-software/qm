import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createNoopLeaderLease } from "../../src/persistence/leader-lease.ts";
import { createMemoryBlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import { createPostgresApprovalStore } from "../../src/slack/approval-store.ts";
import { createPostgresApprovalGrantStore } from "../../src/core/approval-grant-store.ts";
import { createDeliveryStore } from "../../src/delivery/delivery-store.ts";
import { testDatabaseUrl } from "./test-database.ts";

export const singleProcessDeps = (url = testDatabaseUrl()) => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: createPostgresApprovalStore(url, createDeliveryStore()),
  approvalGrants: createPostgresApprovalGrantStore(url),
  blobTransfer: createMemoryBlobTransferStore(),
});
