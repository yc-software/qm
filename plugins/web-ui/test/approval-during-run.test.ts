import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  approvalDecidableDuringRun,
  resolveApproval,
  unresolvedApprovals,
  type PendingApproval,
} from "../src/core-bridge.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("only cards that run their call on approve stay decidable while a reply streams", () => {
  const runsOnApprove = { requestId: "a", command: "send", blocksInput: false, executesOnApprove: true };
  const resumesTurn = { requestId: "b", command: "rm x", blocksInput: false } as PendingApproval;
  const pausesTurn = { requestId: "c", command: "send", blocksInput: true, executesOnApprove: true };
  assert.equal(approvalDecidableDuringRun(runsOnApprove), true);
  assert.equal(approvalDecidableDuringRun(resumesTurn), false);
  assert.equal(approvalDecidableDuringRun(pausesTurn), false);
});

test("a decision handed to the live run hides its card instead of leaving it clickable", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(String(input).endsWith("/api/approvals/live-card"));
    assert.equal(init?.method, "POST");
    const body = { status: "queued", runId: "live-run", steered: true };
    return Response.json(body);
  }) as typeof fetch;
  const cards: PendingApproval[] = [
    { requestId: "live-card", command: "send", blocksInput: false, executesOnApprove: true },
    { requestId: "other-card", command: "send", blocksInput: false, executesOnApprove: true },
  ];
  assert.equal(await resolveApproval({ requestId: "live-card", approved: true, scope: "once" }), "live-run");
  assert.deepEqual(
    unresolvedApprovals(cards).map((card) => card.requestId),
    ["other-card"],
  );
});
