import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { runApprovalTurn } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

function fakeAgent(): Agent {
  return {
    state: {
      model: MODEL,
      messages: [{ role: "user", content: "resolve merge conflicts on this branch" }],
      isStreaming: false,
    },
  } as unknown as Agent;
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

interface RecordedCall {
  url: string;
  body: unknown;
}

function stubApprovalResolve(result: Record<string, unknown>, calls: RecordedCall[] = []): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/approvals/a-1") && init?.method === "POST") {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return jsonResponse({ status: "queued", runId: "r-1" });
    }
    if (url.includes("/api/runs/r-1")) {
      return jsonResponse({ status: "done", result, partial: "" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an approval decision posts the stored-record endpoint, never a reconstructed turn", async () => {
  const calls: RecordedCall[] = [];
  stubApprovalResolve({ status: "ok", reply: "done — pushed." }, calls);
  await runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true, scope: "session" }, undefined);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body as { approved?: boolean; scope?: string; idempotencyKey?: string };
  assert.equal(body.approved, true);
  assert.equal(body.scope, "session");
  assert.match(body.idempotencyKey ?? "", /^[0-9a-f-]{36}$/);
});

test("each decision gesture mints a fresh key, so a retry after a failure is never deduped away", async () => {
  const calls: RecordedCall[] = [];
  stubApprovalResolve({ status: "ok", reply: "done." }, calls);
  await runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true }, undefined);
  await runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true }, undefined);
  const keys = calls.map((c) => (c.body as { idempotencyKey?: string }).idempotencyKey);
  assert.equal(calls.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("a refused approval resume rejects with the refusal reason", async () => {
  stubApprovalResolve({
    status: "refused",
    refusalKind: "session_busy",
    reason:
      "Give me a moment — I'm still finishing something else in this conversation. Send that again in a minute and I'll pick it up.",
  });
  await assert.rejects(
    runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true, scope: "once" }, undefined),
    /finishing something else/,
  );
});

test("a completed approval resume resolves quietly", async () => {
  stubApprovalResolve({ status: "ok", reply: "done — pushed." });
  await runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true, scope: "session" }, undefined);
});

test("a denied approval's refusal is a clean outcome, not an error", async () => {
  stubApprovalResolve({ status: "refused", reason: "approval denied for git push --force" });
  await runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: false }, undefined);
});

function stubResolveResponse(body: unknown, status: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/approvals/a-1") && init?.method === "POST") {
      return jsonResponse(body, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

test("a missing or expired approval record surfaces a visible expiry message", async () => {
  stubResolveResponse({ error: "not_found" }, 404);
  await assert.rejects(
    runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true }, undefined),
    /no longer available/,
  );
});

test("a synchronous core refusal surfaces its reason, not a bare HTTP status", async () => {
  stubResolveResponse(
    {
      status: "refused",
      refusalKind: "session_busy",
      reason:
        "Give me a moment — I'm still finishing something else in this conversation. Send that again in a minute and I'll pick it up.",
    },
    403,
  );
  await assert.rejects(
    runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true }, undefined),
    /finishing something else/,
  );
});

test("a pending_approval response without a run is a visible failure, not quiet success", async () => {
  stubResolveResponse({ status: "pending_approval" }, 200);
  await assert.rejects(
    runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true }, undefined),
    /waiting on a different approval/,
  );
});

test("a pending_approval response carrying a reason surfaces that reason instead of the generic copy", async () => {
  stubResolveResponse(
    { status: "pending_approval", reason: "waiting for another project member to resolve a pending approval" },
    200,
  );
  await assert.rejects(
    runApprovalTurn(fakeAgent(), { requestId: "a-1", approved: true }, undefined),
    /another project member/,
  );
});
