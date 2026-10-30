import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTurnOutcome, approvalBlocksInput } from "../src/core/turn-outcome.ts";

test("a plain reply: completed, nothing pending", () => {
  const o = deriveTurnOutcome({
    reply: "done!",
    attachments: 0,
    pendingApprovals: [],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: false });
});

test("a parked command with no reply: paused and blocking", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    pendingApprovals: [{ kind: "command" }],
    terminatedOnApproval: true,
  });
  assert.deepEqual(o, { completed: false, paused: true, approvalsBlock: true });
});

test("the split-brain case — a reply AND a terminating parked command: completed yet still blocking", () => {
  const o = deriveTurnOutcome({
    reply: "here's what I had before the wall",
    attachments: 0,
    pendingApprovals: [{ kind: "command" }],
    terminatedOnApproval: true,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: true });
});

test("a COLLECTED approval — the agent worked around it and finished — is a non-blocking offer, not a wait", () => {
  const o = deriveTurnOutcome({
    reply: "worked around it; done",
    attachments: 0,
    pendingApprovals: [{ kind: "command" }],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: false });
});

test("an input pause (2FA prompt) with a reply never blocks", () => {
  const o = deriveTurnOutcome({
    reply: "what's the code?",
    attachments: 0,
    pendingApprovals: [{ kind: "input" }],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: false });
});

test("an input pause with no reply still pauses the run", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    pendingApprovals: [{ kind: "input" }],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: false, paused: true, approvalsBlock: true });
});

test("a mixed pause (input + command) with no output pauses and blocks", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    pendingApprovals: [{ kind: "input" }, { kind: "command" }],
    terminatedOnApproval: true,
  });
  assert.deepEqual(o, { completed: false, paused: true, approvalsBlock: true });
});

test("outbound files count as visible output", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 2,
    pendingApprovals: [],
    terminatedOnApproval: false,
  });
  assert.equal(o.completed, true);
});

test("a whitespace-only reply is not visible output", () => {
  const o = deriveTurnOutcome({
    reply: "  \n ",
    attachments: 0,
    pendingApprovals: [],
    terminatedOnApproval: false,
  });
  assert.equal(o.completed, false);
});

test("per-approval blocking: input never blocks; a command blocks only when the turn's approvals block", () => {
  assert.equal(approvalBlocksInput(undefined, { approvalsBlock: true }), true);
  assert.equal(approvalBlocksInput("command", { approvalsBlock: true }), true);
  assert.equal(approvalBlocksInput("input", { approvalsBlock: true }), false);
  assert.equal(approvalBlocksInput("command", { approvalsBlock: false }), false);
});
