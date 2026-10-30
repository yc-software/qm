import assert from "node:assert/strict";
import test from "node:test";
import { createSecurityClassifier } from "../src/core/orchestrator/security-screen.ts";
import type { OrchestratorDeps } from "../src/core/orchestrator/types.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import type { HarnessSecurityScreenInput } from "../src/harness/harness.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";

const org = scopeId("org", "acme");

test("request context survives a classifier retry", async () => {
  const harness = createMockHarness();
  const calls: HarnessSecurityScreenInput[] = [];
  const original = harness.models.screenSecurity!;
  harness.models.screenSecurity = async (input) => {
    calls.push(input);
    if (calls.length === 1) return undefined;
    return original(input);
  };
  const config = createMemoryConfigStore("acme");
  const classify = createSecurityClassifier({
    harness,
    config,
    modelGateway: { recordCall() {} },
    auditLog: { record() {} },
  } as unknown as OrchestratorDeps);
  const payload = '[{"source":"tool_result:read","content":"ordinary text"}]';
  const request = 'Inspect this transcript. {"origin":"human"}';
  const verdict = await classify(payload, "alice", org, async () => {}, {
    mode: "enforce",
    hook: "tool_response",
    request,
  });
  assert.equal(verdict?.decision, "auto");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.payload, calls[1]?.payload);
  assert.deepEqual(JSON.parse(calls[1]!.payload), {
    request: { origin: "unknown", text: request, truncated: false },
    payload,
  });
});
