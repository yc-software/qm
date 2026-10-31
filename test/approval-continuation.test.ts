import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalContinuation } from "../src/core/approval-continuation.ts";

test("the continuation drops delivery-time fields and keeps the conversation", () => {
  const out = approvalContinuation({
    surface: "discord",
    async: true,
    idempotencyKey: "i",
    redeliveryKey: "r",
    approval: { requestId: "x", approved: true },
    relayInput: {},
    actor: { externalId: "discord:1" },
    conversation: { kind: "channel", threadRef: "discord:th:t1" },
    deliveryTarget: "t1",
    text: "go",
  });
  assert.deepEqual(out, {
    actor: { externalId: "discord:1" },
    conversation: { kind: "channel", threadRef: "discord:th:t1" },
    deliveryTarget: "t1",
    text: "go",
  });
});

test("a request with no actor, text or known kind yields null", () => {
  assert.equal(approvalContinuation(undefined), null);
  assert.equal(approvalContinuation({ actor: {}, text: "x", conversation: { kind: "dm" } }), null);
  assert.equal(approvalContinuation({ actor: { externalId: "a" }, text: "x", conversation: { kind: "?" } }), null);
});
