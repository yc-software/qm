import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools } from "../src/harness/agent-tools.ts";
import type { ToolContext } from "../src/tools/primitives.ts";

async function invoke(tool: ReturnType<typeof createAgentTools>[number], params: unknown) {
  return tool.execute("workflow-call", params, undefined, undefined, {} as never);
}

test("the workflow tool delegates only structured gate actions to the host", async () => {
  const received: unknown[] = [];
  const ref = {
    current: {
      workflow: async (input: unknown) => {
        received.push(input);
        return { accepted: true };
      },
    } as ToolContext,
  };
  const workflow = createAgentTools(ref).find((tool) => tool.name === "workflow");
  assert.ok(workflow);

  await invoke(workflow, {
    action: "advance",
    workflowId: "finance",
    step: "raw-evidence-ready",
    decision: "pass",
    outputEvidence: [{ id: "raw" }],
  });

  assert.deepEqual(received, [
    {
      action: "advance",
      workflowId: "finance",
      step: "raw-evidence-ready",
      decision: "pass",
      outputEvidence: [{ id: "raw" }],
    },
  ]);
});

test("read-only reviewers can read skills and submit reviews but cannot advance workflows", async () => {
  const context = {
    workflow: async () => ({ valid: true }),
    skill: async () => ({ content: "audit", sourceScopeId: null }),
    read: async () => ({ content: "evidence", sourceScopeId: null }),
  } as unknown as ToolContext;
  const tools = createAgentTools({ current: context }, { readOnly: true, workflowReview: true });
  const skills = tools.find((tool) => tool.name === "skills");
  const files = tools.find((tool) => tool.name === "files");
  const workflow = tools.find((tool) => tool.name === "workflow");
  assert.ok(skills);
  assert.ok(files);
  assert.ok(workflow);

  await invoke(skills, { action: "read", name: "finance-audit" });
  await invoke(files, { action: "read", path: "shared/evidence.json" });
  await assert.rejects(
    invoke(files, { action: "write", path: "shared/evidence.json", data: "changed" }),
    /unavailable in a read-only turn/,
  );
  await invoke(workflow, {
    action: "review_submit",
    workflowId: "finance",
    step: "auditor-1-pass",
    decision: "pass",
  });
  await assert.rejects(
    invoke(workflow, {
      action: "advance",
      workflowId: "finance",
      step: "auditor-1-pass",
      decision: "pass",
    }),
    /unavailable in a read-only turn/,
  );
});

test("the approval action pauses for a person before it reaches workflow control", async () => {
  const received: unknown[] = [];
  const ref = {
    current: {
      workflow: async (input: unknown) => {
        received.push(input);
        return { accepted: true };
      },
    } as ToolContext,
    pendingApprovals: [],
  };
  const workflow = createAgentTools(ref).find((tool) => tool.name === "workflow");
  assert.ok(workflow);

  await invoke(workflow, {
    action: "approve",
    workflowId: "finance",
    step: "PLAN_APPROVED",
    decision: "pass",
  });

  assert.deepEqual(received, []);
  assert.equal(ref.pendingApprovals.length, 1);
});
