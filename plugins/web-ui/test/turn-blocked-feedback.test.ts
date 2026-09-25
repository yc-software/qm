import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { api, makeCoreStreamFn, queueTurn, PENDING_APPROVAL_REASON } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

interface StreamOutcome {
  stopReason?: string;
  errorMessage?: string;
  sendBlocked?: string;
  content: Array<{ type: string; text?: string }>;
}

function fakeAgent(): Agent {
  return {
    state: {
      model: MODEL,
      messages: [{ role: "user", content: "deploy the fix" }],
      isStreaming: false,
    },
  } as unknown as Agent;
}

function stubTurnResponse(status: number, body: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/turn") && init?.method === "POST") {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function driveOutcome(): Promise<StreamOutcome> {
  const streamFn = makeCoreStreamFn("web:u:t", fakeAgent()) as unknown as (
    model: Model<Api>,
    context: unknown,
  ) => { result(): Promise<StreamOutcome> };
  return streamFn(MODEL, { messages: [] }).result();
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a refused turn surfaces core's reason, not the bare HTTP status", async () => {
  stubTurnResponse(403, { status: "refused", reason: "model gpt-9 is not approved for this deployment" });
  const outcome = await driveOutcome();
  assert.equal(outcome.stopReason, "error");
  assert.match(outcome.errorMessage ?? "", /model gpt-9 is not approved/);
  assert.doesNotMatch(outcome.errorMessage ?? "", /HTTP 403/);
});

test("api() prefers a human message over reason, and reason over a machine error code", async () => {
  stubTurnResponse(403, { error: "forbidden_scope", message: "you can only chat in your personal context" });
  await assert.rejects(api("/api/turn", { method: "POST", body: "{}" }), /personal context/);
  stubTurnResponse(403, { error: "refused", reason: "that model isn't available" });
  await assert.rejects(api("/api/turn", { method: "POST", body: "{}" }), /that model isn't available/);
  stubTurnResponse(404, { error: "not_found" });
  await assert.rejects(api("/api/turn", { method: "POST", body: "{}" }), /not_found/);
  stubTurnResponse(500, {});
  await assert.rejects(api("/api/turn", { method: "POST", body: "{}" }), /HTTP 500/);
});

test("a pending_approval turn is not an empty success — the stream errors with the reason and a marker", async () => {
  stubTurnResponse(200, {
    status: "pending_approval",
    reason: "Approve or deny the pending command to continue.",
    pendingApprovals: [{ requestId: "a-1", command: "rm -rf /tmp/x" }],
  });
  const outcome = await driveOutcome();
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.sendBlocked, "pending_approval");
  assert.equal(outcome.errorMessage, "Approve or deny the pending command to continue.");
});

test("a pending_approval turn without a reason still explains itself", async () => {
  stubTurnResponse(200, { status: "pending_approval" });
  const outcome = await driveOutcome();
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.errorMessage, PENDING_APPROVAL_REASON);
});

test("a queued send blocked by a pending approval rejects with the reason instead of queueing nothing", async () => {
  stubTurnResponse(200, {
    status: "pending_approval",
    reason: "This conversation is waiting for another project member to resolve a pending approval.",
  });
  await assert.rejects(queueTurn("web:u:t", "hello", fakeAgent(), undefined, "key-1"), /another project member/);
});

test("a successfully queued send still resolves with its run", async () => {
  stubTurnResponse(202, { status: "queued", runId: "r-9" });
  const queued = await queueTurn("web:u:t", "hello", fakeAgent(), undefined, "key-1");
  assert.deepEqual(queued, { runId: "r-9", text: "hello" });
});
