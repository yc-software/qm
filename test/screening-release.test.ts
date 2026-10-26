import "./support/auto-fake-sprites.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "./support/mock-harness.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let executions = 0;
let observedRelease = "";
mock.module("./support/mock-harness.ts", {
  namedExports: {
    createMockHarness() {
      const harness = createMockHarness();
      const run = harness.turns.runTurn;
      harness.turns.runTurn = async (turn: HarnessTurnInput) => {
        if (turn.input.startsWith("The human released quarantined")) {
          const held = turn.history.findLast(
            (item) => item.kind === "UserMessage" && item.body.securityReleaseRequestId,
          );
          observedRelease = held?.text ?? "Missing released output";
          const reply = "Released fixture output.";
          await turn.emit({ kind: "UserMessage", text: turn.input });
          await turn.emit({ kind: "AgentMessage", text: reply });
          return { reply };
        }
        if (!turn.input.startsWith("run fixture")) return run(turn);
        await turn.emit({ kind: "UserMessage", text: turn.input });
        const ref: ToolContextRef = {
          current: {
            ...turn.tools,
            async read() {
              return { content: "SCREENING_FIXTURE_BLOCK", sourceScopeId: "personal:U1", shared: true };
            },
            async execute() {
              executions++;
              return { stdout: "SCREENING_FIXTURE_BLOCK", stderr: "", code: 0, timedOut: false };
            },
          },
          emit: turn.emit,
          scopeLabel: turn.scopeLabel,
          orgScopeId: turn.orgScopeId,
          toolApprovalGate: turn.toolApprovalGate,
          screenToolResult: turn.screenToolResult,
          pendingApprovals: [],
        };
        const sharedRead = turn.input.includes("shared");
        const tool = createAgentTools(ref).find((tool) => tool.name === (sharedRead ? "files" : "execute"))!;
        const execute = tool.execute as unknown as (
          id: string,
          args: unknown,
        ) => Promise<{ content: Array<{ text?: string }> }>;
        const result = await execute(
          `fixture-call-${++callSeq}`,
          sharedRead
            ? { action: "read", path: "private.txt" }
            : { command: "printf SCREENING_FIXTURE_BLOCK", purpose: "Check output screening" },
        );
        const reply = result.content.map((part) => part.text ?? "").join("\n");
        await turn.emit({ kind: "AgentMessage", text: reply });
        return { reply, pendingApprovals: ref.pendingApprovals, pausedOnApproval: ref.pausedOnApproval };
      };
      return harness;
    },
  },
});
let callSeq = 0;
const { buildApp } = await import("./support/build-app.ts");

function request(threadRef = "fixture-thread"): TurnRequest {
  return { surface: "test", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef }, text: "run fixture" };
}

for (const securityPosture of ["auto", "strict"] as const) {
  test(`${securityPosture}: real wrapper releases exact saved output without rerunning or widening permissions`, async () => {
    executions = 0;
    const built = buildApp(testConfig({ securityPosture }), {
      securityScreener: {
        provider: "fixture-screen",
        async classify() {
          return { verdict: { decision: "strict", reason: "fixture verdict" }, score: 1, threshold: 0.5 };
        },
      },
    });
    const req = request();
    let blocked = await built.app.turn(req);
    if (securityPosture === "strict") {
      assert.equal(executions, 0);
      assert.equal(blocked.pendingApprovals?.[0]?.approvalKey, "tool:execute");
      blocked = await built.app.turn({
        ...req,
        approval: { requestId: blocked.pendingApprovals![0]!.requestId, approved: true },
      });
    }
    assert.equal(executions, 1);
    assert.equal(blocked.pendingApprovals?.length, 1);
    const release = blocked.pendingApprovals![0]!;
    assert.equal(release.approvalKey, "security-screen-release:execute");
    assert.deepEqual(release.grantModes, { session: false, always: false });
    const results = (await built.sessions.getItems(blocked.sessionId!)).filter((item) => item.kind === "ToolResult");
    assert.ok(results.some((item) => item.body.quarantined));
    assert.doesNotMatch(JSON.stringify(results), /SCREENING_FIXTURE_BLOCK/);
    for (const scope of ["session", "always"] as const) {
      const broad = await built.app.turn({ ...req, approval: { requestId: release.requestId, approved: true, scope } });
      assert.equal(broad.status, "pending_approval");
      assert.match(broad.reason ?? "", /only be released once/);
      assert.equal(executions, 1);
    }
    const approved = await built.app.turn({ ...req, approval: { requestId: release.requestId, approved: true } });
    assert.equal(approved.status, "ok");
    assert.match(observedRelease, /SCREENING_FIXTURE_BLOCK/);
    assert.equal(executions, 1, "release never executes the side effect again");
    const fresh = await built.app.turn(request("second-fixture-thread"));
    assert.equal(fresh.pendingApprovals?.length, 1);
    assert.equal(
      fresh.pendingApprovals?.[0]?.approvalKey,
      securityPosture === "strict" ? "tool:execute" : "security-screen-release:execute",
    );
  });
}

for (const failure of ["error", "timeout"] as const) {
  test(`real tool output is marked and audited when the proxy ${failure}s`, async () => {
    const built = buildApp(testConfig({ securityPosture: "auto", securityScreenTimeoutMs: 10 }), {
      securityScreener: {
        provider: "fixture-screen",
        async classify() {
          if (failure === "timeout") await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("fixture unavailable");
        },
      },
    });
    const result = await built.app.turn(request());
    assert.equal(result.status, "ok");
    assert.match(result.reply ?? "", /NOT security-screened/);
    assert.match(result.reply ?? "", /SCREENING_FIXTURE_BLOCK/);
    const events = await built.auditLog.events();
    assert.ok(events.some((event) => event.action === "security_screen.classify" && event.status === "error"));
    assert.ok(events.some((event) => event.action === "security_posture.tool_result_failed_open"));
  });
}
