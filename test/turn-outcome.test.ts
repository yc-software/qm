import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTurnOutcome, approvalBlocksInput, sessionStateAfterTurn } from "../src/core/turn-outcome.ts";

test("a plain reply: completed, nothing pending", () => {
  const o = deriveTurnOutcome({
    reply: "done!",
    attachments: 0,
    issues: 0,
    pendingApprovals: [],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: false, awaitingApproval: false });
});

test("a parked command with no reply: paused AND awaiting approval", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    issues: 0,
    pendingApprovals: [{ kind: "command" }],
    terminatedOnApproval: true,
  });
  assert.deepEqual(o, { completed: false, paused: true, approvalsBlock: true, awaitingApproval: true });
});

test("the split-brain case — a reply AND a terminating parked command: completed yet still awaiting approval", () => {
  const o = deriveTurnOutcome({
    reply: "here's what I had before the wall",
    attachments: 0,
    issues: 0,
    pendingApprovals: [{ kind: "command" }],
    terminatedOnApproval: true,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: true, awaitingApproval: true });
});

test("a COLLECTED approval — the agent worked around it and finished — is a non-blocking offer, not a wait", () => {
  const o = deriveTurnOutcome({
    reply: "worked around it; done",
    attachments: 0,
    issues: 0,
    pendingApprovals: [{ kind: "command" }],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: false, awaitingApproval: false });
});

test("an input pause (2FA prompt) never blocks and never marks the session awaiting approval", () => {
  const o = deriveTurnOutcome({
    reply: "what's the code?",
    attachments: 0,
    issues: 0,
    pendingApprovals: [{ kind: "input" }],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: true, paused: false, approvalsBlock: false, awaitingApproval: false });
});

test("an input pause with no reply still pauses the run but is not awaiting approval", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    issues: 0,
    pendingApprovals: [{ kind: "input" }],
    terminatedOnApproval: false,
  });
  assert.deepEqual(o, { completed: false, paused: true, approvalsBlock: true, awaitingApproval: false });
});

test("a mixed pause (input + command) with no output is awaiting approval", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    issues: 0,
    pendingApprovals: [{ kind: "input" }, { kind: "command" }],
    terminatedOnApproval: true,
  });
  assert.deepEqual(o, { completed: false, paused: true, approvalsBlock: true, awaitingApproval: true });
});

test("outbound files count as visible output", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 2,
    issues: 0,
    pendingApprovals: [],
    terminatedOnApproval: false,
  });
  assert.equal(o.completed, true);
});

test("an outbound file issue counts as visible output (a notes-only turn stays in the ok lane)", () => {
  const o = deriveTurnOutcome({
    reply: "",
    attachments: 0,
    issues: 1,
    pendingApprovals: [],
    terminatedOnApproval: false,
  });
  assert.equal(o.completed, true);
});

test("a whitespace-only reply is not visible output", () => {
  const o = deriveTurnOutcome({
    reply: "  \n ",
    attachments: 0,
    issues: 0,
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

test("session state after the turn: awaiting_approval wins over idle", () => {
  assert.equal(
    sessionStateAfterTurn(
      deriveTurnOutcome({ reply: "x", attachments: 0, issues: 0, pendingApprovals: [], terminatedOnApproval: false }),
    ),
    "idle",
  );
  assert.equal(
    sessionStateAfterTurn(
      deriveTurnOutcome({
        reply: "x",
        attachments: 0,
        issues: 0,
        pendingApprovals: [{ kind: "command" }],
        terminatedOnApproval: true,
      }),
    ),
    "awaiting_approval",
  );
  assert.equal(
    sessionStateAfterTurn(
      deriveTurnOutcome({
        reply: "",
        attachments: 0,
        issues: 0,
        pendingApprovals: [{ kind: "input" }],
        terminatedOnApproval: false,
      }),
    ),
    "idle",
  );
});
