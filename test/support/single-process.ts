import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createNoopLeaderLease } from "../../src/persistence/leader-lease.ts";
import type { CommandApprovalGrant, PendingApprovalRecord } from "../../src/types.ts";
import type { PromptSnapshot } from "../../src/core/orchestrator/prompt-snapshot.ts";
import { testMap, testUsers } from "./test-database.ts";
import { createDeliveryStore } from "../../src/delivery/delivery-store.ts";
import { createSurfaceRegistry } from "../../src/surfaces/registry.ts";
import { createSlackSurface } from "../../src/surfaces/slack/adapter.ts";
import { createMemoryBlobTransferStore } from "./memory-byte-stores.ts";

export const testSurfaces = () =>
  createSurfaceRegistry({ surfaces: [createSlackSurface({ deliveries: createDeliveryStore() })] });

export const singleProcessDeps = () => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: testMap<PendingApprovalRecord>(),
  approvalGrants: testMap<CommandApprovalGrant>(),
  promptSnapshots: testMap<PromptSnapshot>(),
  blobTransfer: createMemoryBlobTransferStore(),
  surfaces: testSurfaces(),
  users: testUsers(),
});
