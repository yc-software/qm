import assert from "node:assert/strict";
import test from "node:test";
import { actionApproved } from "../src/api/action-approval.ts";
import { APPROVED_ACTION_HEADER, API_ACTION_TOOL } from "../src/api/contract.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { Item } from "../src/sessions/items.ts";
import type { PendingApprovalRecord } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

const PATH = "/v1/admin/scopes/org/model";
const BODY = { modelId: "m1" };

function harness(items: Item[] = [], headers: Record<string, string> = {}, body: unknown = BODY) {
  const approvals = testMap<PendingApprovalRecord>();
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = {
    req: { headers: {} },
    getHeader: () => undefined,
    writeHead(status: number) {
      sent.push({ status, body: undefined });
    },
    end(text: string) {
      sent[sent.length - 1]!.body = JSON.parse(text);
    },
  };
  const ctx = {
    req: { headers },
    res,
    method: "PUT",
    url: new URL(`http://core${PATH}`),
    body,
    capability: { actorId: "owner@example.com", sessionId: "s1", runId: "r1" },
    deps: {
      approvals,
      runs: {
        get: async () => ({
          request: {
            surface: "cron",
            actor: { id: "owner@example.com", externalId: "owner@example.com" },
            conversation: { kind: "dm", threadRef: "cron:c1:k1", audience: [] },
            origin: { kind: "automation", fire: true },
            text: "set the model",
          },
        }),
      },
      sessions: { getItems: async () => items },
    },
  } as unknown as ApiCtx;
  return { ctx, approvals, sent };
}

function decided(requestId: string, input: unknown, finished = false): Item[] {
  const base = { seq: 1, turnId: "r1", createdAt: 1, variant: null, step: null, text: null } as const;
  return [
    {
      ...base,
      kind: "ElicitationResponse",
      elicitId: requestId,
      approved: true,
      author: "owner@example.com",
      body: { call: { tool: API_ACTION_TOOL, input, requestId }, approvalKey: "api:k" },
    },
    { ...base, kind: "ToolCall", callId: "c1", author: null, body: { approvedRequestId: requestId } },
    ...(finished ? [{ ...base, kind: "ToolResult", callId: "c1", author: null, body: {} }] : []),
  ] as unknown as Item[];
}

test("an agent request without an approval raises one card for that exact request", async () => {
  const { ctx, approvals, sent } = harness();
  assert.equal(await actionApproved(ctx, { summary: "Change model for org" }), false);
  assert.equal(sent[0]?.status, 202);
  assert.equal((sent[0]!.body as { error: string }).error, "approval_required");
  const [entry] = await approvals.entries();
  const record = entry?.[1];
  assert.deepEqual(record!.call, { tool: API_ACTION_TOOL, input: { method: "PUT", path: PATH, body: BODY } });
  assert.equal(record!.request?.actor.externalId, "owner@example.com");
  assert.equal(record!.blocksInput, false);
  await actionApproved(harness().ctx, { summary: "again" });
  assert.equal((await approvals.entries()).length, 1);
});

test("the approved request runs once and only for the exact approved body", async () => {
  const action = { method: "PUT", path: PATH, body: BODY };
  const ok = harness(decided("A1", action), { [APPROVED_ACTION_HEADER]: "A1" });
  assert.equal(await actionApproved(ok.ctx, { summary: "x" }), true);
  const other = harness(decided("A1", action), { [APPROVED_ACTION_HEADER]: "A1" }, { modelId: "m2" });
  assert.equal(await actionApproved(other.ctx, { summary: "x" }), false);
  assert.equal(other.sent[0]?.status, 403);
  const replayed = harness(decided("A1", action, true), { [APPROVED_ACTION_HEADER]: "A1" });
  assert.equal(await actionApproved(replayed.ctx, { summary: "x" }), false);
  const forged = harness([], { [APPROVED_ACTION_HEADER]: "A1" });
  assert.equal(await actionApproved(forged.ctx, { summary: "x" }), false);
});

test("requests not made by an agent pass straight through", async () => {
  const { ctx } = harness();
  assert.equal(await actionApproved({ ...ctx, capability: null }, { summary: "x" }), true);
});
