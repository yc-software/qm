import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachPendingApprovals,
  fetchSessionApprovals,
  resolveApproval,
  runApprovalTurn,
  unresolvedApprovals,
  type PendingApproval,
} from "../src/core-bridge.ts";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

const approval = (id: string): PendingApproval => ({
  requestId: `keychain:${id}`,
  command: "aws",
  reason: "Credential approval",
});

test("accepted credential decisions survive failed refreshes and late pending responses", async () => {
  const pending = approval("refresh-race");
  const other = approval("unrelated");
  const original = globalThis.fetch;
  let finishRead!: (response: Response) => void;
  let posts = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json({ ask: { status: "approved" } });
    }
    return new Promise<Response>((resolve) => {
      finishRead = resolve;
    });
  }) as typeof fetch;
  try {
    const staleRead = fetchSessionApprovals("parent");
    await resolveApproval({ requestId: pending.requestId, approved: true, scope: "always" });
    assert.deepEqual(unresolvedApprovals([pending, other]), [other]);
    finishRead(Response.json({ approvals: [pending, other] }));
    assert.deepEqual(await staleRead, { approvals: [other] });
    globalThis.fetch = (async () => {
      throw new Error("network unavailable");
    }) as typeof fetch;
    assert.equal(await fetchSessionApprovals("child"), null);
    assert.deepEqual(unresolvedApprovals([pending, other]), [other]);
    const messages: AgentMessage[] = [];
    attachPendingApprovals(messages, [pending]);
    assert.deepEqual(messages, []);
    await resolveApproval({ requestId: pending.requestId, approved: true, scope: "always" });
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("failed and still-pending decisions remain retryable", async () => {
  const pending = approval("retryable");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;
    await assert.rejects(resolveApproval({ requestId: pending.requestId, approved: true, scope: "once" }));
    assert.deepEqual(unresolvedApprovals([pending]), [pending]);
    globalThis.fetch = (async () => Response.json({ ask: { status: "pending" } })) as typeof fetch;
    await assert.rejects(
      resolveApproval({ requestId: pending.requestId, approved: true, scope: "once" }),
      /still pending/,
    );
    assert.deepEqual(unresolvedApprovals([pending]), [pending]);
    globalThis.fetch = (async () => Response.json({ ask: { status: "declined" } })) as typeof fetch;
    await resolveApproval({ requestId: pending.requestId, approved: false });
    assert.deepEqual(unresolvedApprovals([pending]), []);
  } finally {
    globalThis.fetch = original;
  }
});

test("read-only approval turns use the credential endpoint and preserve duration", async () => {
  const original = globalThis.fetch;
  const calls: Array<[string, unknown]> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push([String(url), JSON.parse(String(init?.body))]);
    return Response.json({ ask: { status: "approved" } });
  }) as typeof fetch;
  try {
    await runApprovalTurn({} as Agent, { requestId: "keychain:readonly", approved: true, scope: "once" }, undefined);
    assert.deepEqual(calls, [["/api/keychain/approvals/readonly", { decision: "once" }]]);
  } finally {
    globalThis.fetch = original;
  }
});
