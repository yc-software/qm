import test from "node:test";
import assert from "node:assert/strict";
import { approvalBlocksComposer, type PendingApproval } from "../src/core-bridge.ts";

test("only approvals that block input lock the composer", () => {
  const blocking = { requestId: "a", command: "rm x" } as PendingApproval;
  const explicit = { requestId: "b", command: "rm y", blocksInput: true } as PendingApproval;
  const nonBlocking = { requestId: "c", command: "send it?", blocksInput: false } as PendingApproval;
  assert.equal(approvalBlocksComposer(blocking), true);
  assert.equal(approvalBlocksComposer(explicit), true);
  assert.equal(approvalBlocksComposer(nonBlocking), false);
});
