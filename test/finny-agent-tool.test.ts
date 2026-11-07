import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createToolContext, type ToolContext } from "../src/tools/primitives.ts";
import type { FinnyToolService } from "../src/agent/agent-tools/finny.ts";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { Check } from "typebox/value";

const service = {
  async createPlan() {
    return "plan created";
  },
  async status() {
    return "awaiting approval";
  },
  async artifactReady() {
    return "artifact recorded";
  },
  async pass() {
    return "check passed";
  },
  async block() {
    return "check blocked";
  },
  async deterministicAudit() {
    return "deterministic audit recorded";
  },
  async finalize() {
    return "job finalized";
  },
};

function context(): ToolContext {
  return { finny: service } as unknown as ToolContext;
}

test("finny is exposed only when its bound service exists and the turn is writable", () => {
  assert.equal(
    createAgentTools({ current: {} as ToolContext }).some((tool) => tool.name === "finny"),
    false,
  );
  assert.equal(
    createAgentTools({ current: context() }).some((tool) => tool.name === "finny"),
    true,
  );
  assert.equal(
    createAgentTools({ current: context() }, { readOnly: true }).some((tool) => tool.name === "finny"),
    false,
  );
});

const plan = {
  title: "October close",
  summary: "Prepare the management pack",
  phases: [{ name: "Prepare", owner: "Producer", dependencies: [] }],
  certification: "Independent audit",
  deliverable: "Management workbook",
  destination: "Finance leadership",
  clarifications: [{ question: "Currency?", answer: "INR" }],
};

function finnyTool() {
  const tool = createAgentTools({ current: context() }).find((candidate) => candidate.name === "finny");
  assert.ok(tool);
  return tool;
}

test("finny schema accepts only narrow content and evidence actions", () => {
  const schema = finnyTool().parameters;
  const valid = [
    { action: "create_plan", plan },
    {
      action: "create_plan",
      plan: { ...plan, clarifications: [{ question: "Basis?", answer: "Contracts" }] },
      materialClarification: {
        question: "Basis?",
        options: [
          { id: "contracts", label: "Contracts" },
          { id: "invoices", label: "Invoices", description: "Use issued invoices" },
        ],
        recommendedOptionId: "contracts",
      },
    },
    { action: "status", jobId: "job-1" },
    {
      action: "artifact_ready",
      artifactDigest: "sha256:artifact",
      provisionalRevision: "revision-1",
      idempotencyKey: "ready-1",
    },
    {
      action: "pass",
      checkId: "financial.reconcile",
      generation: 1,
      evidenceFileId: "evidence-file-1",
      idempotencyKey: "pass-1",
    },
    {
      action: "block",
      checkId: "formula.recalculate",
      generation: 2,
      evidenceFileId: "evidence-file-1",
      findings: [{ code: "FORMULA_ERROR", message: "Formula does not recalculate" }],
      idempotencyKey: "block-1",
    },
    { action: "deterministic_audit", idempotencyKey: "deterministic-1" },
    { action: "finalize", jobId: "job-1", idempotencyKey: "finalize-1" },
  ];
  for (const input of valid) assert.ok(Check(schema, input), JSON.stringify(input));
});

test("finny schema rejects model-supplied authority and escalation fields", () => {
  const schema = finnyTool().parameters;
  const base = { action: "status", jobId: "job-1" };
  const forbidden = [
    "grantToken",
    "scopeId",
    "actorId",
    "runId",
    "sessionId",
    "role",
    "requiredChecks",
    "artifactDigest",
    "approvalReceipt",
    "provisionalRevision",
    "deliveryRevision",
    "issuerPrincipalId",
    "issuerRunId",
    "evidenceDigest",
    "changeKinds",
    "resolution",
    "retryLimit",
    "escalationLimit",
    "requestId",
    "originThreadRef",
    "authorizedActorId",
  ];
  for (const field of forbidden) {
    assert.equal(Check(schema, { ...base, [field]: field === "requiredChecks" ? [] : "forbidden" }), false, field);
  }
  assert.equal(Check(schema, { action: "create_plan", plan: { ...plan, scopeId: "org:acme" } }), false);
  assert.equal(Check(schema, { action: "deterministic_audit", idempotencyKey: "audit-1", verdict: "pass" }), false);
  assert.equal(
    Check(schema, {
      action: "create_plan",
      plan,
      materialClarification: {
        question: "Basis?",
        options: [{ id: "only", label: "Only" }],
        recommendedOptionId: "only",
      },
    }),
    false,
  );
});

const execute = async (tool: ReturnType<typeof finnyTool>, id: string, params: unknown) =>
  (tool.execute as unknown as (callId: string, input: unknown) => Promise<{ content: Array<{ text: string }> }>)(
    id,
    params,
  );

test("finny forwards only narrow inputs and returns concise bound-service text", async () => {
  const calls: Array<[string, unknown]> = [];
  const bound: FinnyToolService = {
    async createPlan(input) {
      calls.push(["create_plan", input]);
      return "created job-1";
    },
    async status(input) {
      calls.push(["status", input]);
      return "job-1 awaiting approval";
    },
    async artifactReady(input) {
      calls.push(["artifact_ready", input]);
      return "artifact accepted";
    },
    async pass(input) {
      calls.push(["pass", input]);
      return "check accepted";
    },
    async block(input) {
      calls.push(["block", input]);
      return "block accepted; Core selected rework";
    },
    async deterministicAudit(input: { idempotencyKey: string }) {
      calls.push(["deterministic_audit", input]);
      return "deterministic audit accepted";
    },
    async finalize(input) {
      calls.push(["finalize", input]);
      return "job finalized";
    },
  };
  const tool = createAgentTools({ current: { finny: bound } as unknown as ToolContext }).find(
    (candidate) => candidate.name === "finny",
  );
  assert.ok(tool);
  const inputs = [
    { action: "create_plan", plan },
    { action: "status", jobId: "job-1", retrySafe: true },
    {
      action: "artifact_ready",
      artifactDigest: "sha256:artifact",
      provisionalRevision: "revision-1",
      idempotencyKey: "ready-1",
      retrySafe: true,
    },
    {
      action: "pass",
      checkId: "financial.reconcile",
      generation: 1,
      evidenceFileId: "evidence-pass-file",
      idempotencyKey: "pass-1",
      retrySafe: true,
    },
    {
      action: "block",
      checkId: "formula.recalculate",
      generation: 2,
      evidenceFileId: "evidence-block-file",
      findings: [{ code: "FORMULA_ERROR", message: "Formula does not recalculate" }],
      idempotencyKey: "block-1",
      retrySafe: true,
    },
    { action: "deterministic_audit", idempotencyKey: "deterministic-1", retrySafe: true },
    { action: "finalize", jobId: "job-1", idempotencyKey: "finalize-1", retrySafe: true },
  ];
  const replies = [];
  for (const [index, input] of inputs.entries()) {
    replies.push((await execute(tool, `call-${index}`, input)).content[0]?.text);
  }
  assert.deepEqual(replies, [
    "created job-1",
    "job-1 awaiting approval",
    "artifact accepted",
    "check accepted",
    "block accepted; Core selected rework",
    "deterministic audit accepted",
    "job finalized",
  ]);
  assert.deepEqual(calls, [
    ["create_plan", plan],
    ["status", "job-1"],
    [
      "artifact_ready",
      { artifactDigest: "sha256:artifact", provisionalRevision: "revision-1", idempotencyKey: "ready-1" },
    ],
    [
      "pass",
      {
        checkId: "financial.reconcile",
        generation: 1,
        evidenceFileId: "evidence-pass-file",
        idempotencyKey: "pass-1",
      },
    ],
    [
      "block",
      {
        checkId: "formula.recalculate",
        generation: 2,
        evidenceFileId: "evidence-block-file",
        findings: [{ code: "FORMULA_ERROR", message: "Formula does not recalculate" }],
        idempotencyKey: "block-1",
      },
    ],
    ["deterministic_audit", { idempotencyKey: "deterministic-1" }],
    ["finalize", { jobId: "job-1", idempotencyKey: "finalize-1" }],
  ]);
});

test("tool context carries the injected bound Finny service", () => {
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };
  const toolContext = createToolContext({
    finny: service,
    sandbox: {} as Sandbox,
    provision: async () => handle,
    writableScopeId: scopeId("personal", "U1"),
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  assert.equal(toolContext.finny, service);
});

test("finny retry annotations reject replaying non-idempotent plan creation", () => {
  const schema = finnyTool().parameters;
  assert.ok(Check(schema, { action: "create_plan", plan, retrySafe: false }));
  assert.equal(Check(schema, { action: "create_plan", plan, retrySafe: true }), false);
  assert.ok(Check(schema, { action: "status", jobId: "job-1", retrySafe: true }));
  assert.ok(
    Check(schema, {
      action: "pass",
      checkId: "financial.reconcile",
      generation: 1,
      evidenceFileId: "evidence-file-1",
      idempotencyKey: "pass-1",
      retrySafe: true,
    }),
  );
});

test("finny refuses forbidden fields before invoking its bound service", async () => {
  let calls = 0;
  const bound = {
    ...service,
    async status() {
      calls += 1;
      return "status";
    },
  };
  const tool = createAgentTools({ current: { finny: bound } as unknown as ToolContext }).find(
    (candidate) => candidate.name === "finny",
  );
  assert.ok(tool);
  const result = await execute(tool, "forbidden", {
    action: "status",
    jobId: "job-1",
    actorId: "attacker",
  });
  assert.equal(calls, 0);
  assert.match(result.content[0]?.text ?? "", /Invalid arguments/);
});
