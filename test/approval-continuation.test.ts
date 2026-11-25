import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_SURFACE, createApprovalContinuation } from "../src/triggers/approval-continuation.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { PendingApprovalRecord, TurnRequest, TurnResult } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

const FIRE: TurnRequest = {
  surface: "cron",
  actor: { externalId: "U_OWNER" },
  conversation: { kind: "dm", threadRef: "cron:c1:k1" },
  text: "set the org model",
  origin: { kind: "automation", fire: true, destination: { type: "principal", target: "U_OWNER" } },
} as TurnRequest;

function setup() {
  const approvals = testMap<PendingApprovalRecord>();
  const runs: TurnRequest[] = [];
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const continueApproval = createApprovalContinuation({
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(testMap<IdempotencyRecord>()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async (req) => {
      runs.push(req);
      finished();
      return { status: "ok", reply: "done" } as TurnResult;
    },
    approvals,
  });
  return { approvals, runs, done, continueApproval };
}

test("approving a fire's card continues that fire's session with the decision attached", async () => {
  const { approvals, runs, done, continueApproval } = setup();
  await approvals.put("A1", {
    sessionId: "s1",
    command: "PUT /v1/x",
    createdAt: 1,
    request: FIRE,
  } as PendingApprovalRecord);
  const decision = { requestId: "A1", approved: true, scope: "once" as const };
  assert.deepEqual(await continueApproval(decision, "U_OWNER"), { status: "queued" });
  await done;
  assert.equal(runs[0]?.surface, APPROVAL_SURFACE);
  assert.equal(runs[0]?.conversation.threadRef, "cron:c1:k1");
  assert.deepEqual(runs[0]?.approval, decision);
  assert.equal(runs[0]?.actor.externalId, "U_OWNER");
});

test("only the card's own person can continue it", async () => {
  const { approvals, runs, continueApproval } = setup();
  await approvals.put("A1", { sessionId: "s1", command: "x", createdAt: 1, request: FIRE } as PendingApprovalRecord);
  const result = await continueApproval({ requestId: "A1", approved: true }, "U_OTHER");
  assert.equal(result.status, "refused");
  assert.equal((await continueApproval({ requestId: "missing", approved: true }, "U_OWNER")).status, "refused");
  assert.equal(runs.length, 0);
});
