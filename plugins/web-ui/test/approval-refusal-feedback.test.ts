import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { resolveApproval } from "../src/core-bridge.ts";

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

test("approval resolution delegates replay to its dedicated endpoint", async () => {
  let request = { url: "", body: "" };
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), body: String(init?.body) };
    return { ok: true, status: 202, text: async () => JSON.stringify({ runId: "r-1" }) } as Response;
  }) as typeof fetch;

  assert.equal(await resolveApproval({ requestId: "a/1", approved: true, scope: "once" }), "r-1");
  assert.match(request.url, /\/api\/approvals\/a%2F1$/);
  assert.deepEqual(JSON.parse(request.body), { approved: true, scope: "once" });
});
