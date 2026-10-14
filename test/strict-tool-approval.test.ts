import "./support/auto-fake-sprites.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createServer } from "../src/api/server.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let args: Record<string, unknown> = {};
let writes: Record<string, unknown>[] = [];
let callsPerTurn = 1;
let legacyPause = false;

mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    createMockHarness() {
      const harness = createMockHarness();
      harness.turns.runTurn = async (turn: HarnessTurnInput) => {
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        const ref: ToolContextRef = {
          current: {
            ...turn.tools,
            async callMcpTool(_name, input) {
              writes.push(structuredClone(input));
              return "Fixture write accepted";
            },
          },
          emit: turn.emit,
          scopeLabel: turn.scopeLabel,
          toolApprovalGate: turn.toolApprovalGate,
          pendingApprovals: [],
        };
        const tool = createAgentTools(ref, {
          mcpTools: () => [
            {
              name: "fixture_send",
              serverId: "fixture",
              remoteName: "send",
              description: "Record a synthetic message",
              inputSchema: { type: "object", properties: {} },
              readOnly: false,
            },
          ],
        }).find((candidate) => candidate.name === "fixture_send")!;
        let reply = "";
        for (let i = 0; i < callsPerTurn; i++) {
          const result = await (
            tool.execute as unknown as (id: string, input: unknown) => Promise<{ content: Array<{ text?: string }> }>
          )(`fixture-call-${i}`, args);
          reply = result.content.map((part) => part.text ?? "").join("\n");
          if (ref.pausedOnApproval) break;
        }
        if (!ref.pausedOnApproval)
          await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
        if (legacyPause) for (const pending of ref.pendingApprovals ?? []) delete pending.toolCallKey;
        return {
          reply: ref.pausedOnApproval ? "" : reply,
          pendingApprovals: ref.pendingApprovals,
          pausedOnApproval: ref.pausedOnApproval,
        };
      };
      return harness;
    },
  },
});

const { buildApp } = await import("../src/wiring.ts");
const SECRET = "synthetic-approval-fixture-key-32-chars";

async function fixture(run: (send: (approval?: TurnRequest["approval"]) => Promise<TurnResult>) => Promise<void>) {
  writes = [];
  callsPerTurn = 1;
  legacyPause = false;
  args = { recipient: "mailbox-a", message: { subject: "Fixture", body: "Approved body" } };
  const built = buildApp(testConfig({ securityPosture: "strict", signingSecret: SECRET }));
  await built.config.setSecurityPosture("org:default-org", "strict");
  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (approval) => {
      const body = JSON.stringify({
        idempotencyKey: randomUUID(),
        surface: "test",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: "fixture-approval" },
        text: "Send the synthetic fixture message",
        ...(approval ? { approval } : {}),
      });
      const response = await fetch(`${base}/v1/turns`, {
        method: "POST",
        headers: signedRequestHeaders(SECRET, "POST", "/v1/turns", body, { "content-type": "application/json" }),
        body,
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<TurnResult>;
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await built.runtime.stop();
  }
}

for (const change of ["recipient", "body"] as const) {
  test(`one-time tool approval cannot authorize a changed ${change}`, async () => {
    await fixture(async (send) => {
      const first = await send();
      assert.equal(first.status, "pending_approval");
      assert.equal(writes.length, 0);
      const pending = first.pendingApprovals![0]!;
      if (change === "recipient") args.recipient = "mailbox-b";
      else args.message = { subject: "Fixture", body: "Changed body" };
      const changed = await send({ requestId: pending.requestId, approved: true });
      assert.equal(changed.status, "pending_approval");
      assert.equal(writes.length, 0, "the connector must not see an unapproved payload");
      assert.notEqual(changed.pendingApprovals![0]!.requestId, pending.requestId);
      const approved = await send({ requestId: changed.pendingApprovals![0]!.requestId, approved: true });
      assert.equal(approved.status, "ok");
      assert.deepEqual(writes, [args]);
    });
  });
}

test("one-time approval accepts reordered object keys but is consumed by one invocation", async () => {
  await fixture(async (send) => {
    const first = await send();
    args = { message: { body: "Approved body", subject: "Fixture" }, recipient: "mailbox-a", retrySafe: true };
    const approved = await send({ requestId: first.pendingApprovals![0]!.requestId, approved: true });
    assert.equal(approved.status, "ok");
    assert.equal(writes.length, 1);
    const next = await send();
    assert.equal(next.status, "pending_approval");
    assert.equal(writes.length, 1);
    assert.notEqual(next.pendingApprovals![0]!.requestId, first.pendingApprovals![0]!.requestId);
    const stale = await send({ requestId: first.pendingApprovals![0]!.requestId, approved: true });
    assert.equal(stale.status, "pending_approval");
    assert.equal(stale.pendingApprovals![0]!.requestId, next.pendingApprovals![0]!.requestId);
    assert.equal(writes.length, 1);
  });
});

test("one-time tool approval permits only one invocation within a turn", async () => {
  await fixture(async (send) => {
    callsPerTurn = 2;
    const first = await send();
    const approved = await send({ requestId: first.pendingApprovals![0]!.requestId, approved: true });
    assert.equal(approved.status, "pending_approval");
    assert.deepEqual(writes, [args]);
    assert.notEqual(approved.pendingApprovals![0]!.requestId, first.pendingApprovals![0]!.requestId);
  });
});

for (const scope of ["session", "always"] as const)
  test(`explicit ${scope}-wide tool approval remains broader than one payload`, async () => {
    await fixture(async (send) => {
      const first = await send();
      args.recipient = "mailbox-b";
      const approved = await send({ requestId: first.pendingApprovals![0]!.requestId, approved: true, scope });
      assert.equal(approved.status, "ok");
      assert.deepEqual(writes, [args]);
    });
  });

test("an older pending tool approval re-prompts once, then accepts fresh approval", async () => {
  await fixture(async (send) => {
    legacyPause = true;
    const first = await send();
    legacyPause = false;
    const next = await send({ requestId: first.pendingApprovals![0]!.requestId, approved: true });
    assert.equal(next.status, "pending_approval");
    assert.equal(writes.length, 0);
    const approved = await send({ requestId: next.pendingApprovals![0]!.requestId, approved: true });
    assert.equal(approved.status, "ok");
    assert.deepEqual(writes, [args]);
  });
});
