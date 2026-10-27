import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecurityObserver } from "../../../src/core/orchestrator/security-screen.ts";
import { screeningGate } from "../../../src/core/orchestrator/screening-gate.ts";
import type { OrchestratorDeps } from "../../../src/core/orchestrator/types.ts";
import type { SecurityScreener } from "../../../src/security/security-screener.ts";
import type { ScopeId } from "../../../src/types.ts";

function observerWith(screener: SecurityScreener | undefined) {
  const statuses: string[] = [];
  const deps = {
    ...(screener ? { securityScreener: screener } : {}),
    harness: { models: {} },
    auditLog: { record: (event: { status: string }) => statuses.push(event.status) },
  } as unknown as OrchestratorDeps;
  return { observe: createSecurityObserver(deps), statuses };
}

const strictScreener: SecurityScreener = {
  provider: "fixture",
  classify: async () => ({ score: 1, threshold: 0.5, verdict: { decision: "strict", reason: "fixture" } }),
};

test("the screening gate allows every verdict while enforcement is off", () => {
  for (const hook of ["user_input", "tool_response"] as const) {
    assert.deepEqual(screeningGate({ hook, verdict: { decision: "strict", reason: "x" } }), { action: "allow" });
    assert.deepEqual(screeningGate({ hook, verdict: { decision: "auto" } }), { action: "allow" });
    assert.deepEqual(screeningGate({ hook }), { action: "allow" });
  }
});

test("a would-block verdict still reaches the gate and is allowed", async () => {
  const { observe, statuses } = observerWith(strictScreener);
  const decision = await observe("[]", "U1", "org" as ScopeId, { hook: "tool_response", origin: "human" });
  assert.deepEqual(decision, { action: "allow" });
  assert.deepEqual(statuses, ["would_block"]);
});

test("screener failures and missing screeners allow", async () => {
  const failing = observerWith({ provider: "fixture", classify: () => Promise.reject(new Error("down")) });
  assert.deepEqual(await failing.observe("[]", "U1", "org" as ScopeId, {}), { action: "allow" });
  assert.deepEqual(failing.statuses, ["error"]);
  const none = observerWith(undefined);
  assert.deepEqual(await none.observe("[]", "U1", "org" as ScopeId, {}), { action: "allow" });
  assert.deepEqual(none.statuses, []);
});
