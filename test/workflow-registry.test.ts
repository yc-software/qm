import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowDefinitions } from "../src/sessions/workflow-registry.ts";

test("workflow definitions load from the deployment layer with ordered references", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        {
          id: "finance",
          version: 1,
          agent: "finance-ops",
          reviewAgent: "finance-auditor",
          sourceExecution: {
            approvalStep: "PLAN_APPROVED",
            compiler: {
              skillName: "finance-compiler",
              path: "scripts/compile.py",
              contentDigest: "b".repeat(64),
            },
            expectedPopulations: ["receipts", "open-receivables"],
          },
          steps: [
            { id: "evidence", role: "producer", requiredSkills: [] },
            {
              id: "PLAN_APPROVED",
              role: "producer",
              humanApproval: true,
              after: "evidence",
              evidenceFrom: "evidence",
              requiredSkills: [],
            },
            {
              id: "audit",
              role: "auditor",
              after: "PLAN_APPROVED",
              separateFrom: "PLAN_APPROVED",
              evidenceFrom: "PLAN_APPROVED",
              requiredSkills: [
                {
                  skillId: "11111111-1111-4111-8111-111111111111",
                  contentDigest: "a".repeat(64),
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  const loaded = loadWorkflowDefinitions(dir)[0];
  assert.equal(loaded?.steps[2]?.id, "audit");
  assert.equal(loaded?.agent, "finance-ops");
  assert.equal(loaded?.reviewAgent, "finance-auditor");
  assert.deepEqual(loaded?.sourceExecution, {
    approvalStep: "PLAN_APPROVED",
    compiler: {
      skillName: "finance-compiler",
      path: "scripts/compile.py",
      contentDigest: "b".repeat(64),
    },
    expectedPopulations: ["receipts", "open-receivables"],
  });
});

test("workflow definitions reject a step that combines human approval with reviewer separation", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-approval-reviewer-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        {
          id: "finance",
          version: 1,
          steps: [
            { id: "plan", role: "producer", requiredSkills: [] },
            {
              id: "PLAN_APPROVED",
              role: "producer",
              humanApproval: true,
              after: "plan",
              separateFrom: "plan",
              requiredSkills: [],
            },
          ],
        },
      ],
    }),
  );

  assert.throws(() => loadWorkflowDefinitions(dir), /cannot combine human approval with reviewer separation/);
});

test("workflow definitions reject forward references and duplicate ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-invalid-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        {
          id: "finance",
          version: 1,
          steps: [
            { id: "audit", role: "auditor", after: "evidence", requiredSkills: [] },
            { id: "evidence", role: "producer", requiredSkills: [] },
            { id: "evidence", role: "producer", requiredSkills: [] },
          ],
        },
      ],
    }),
  );

  assert.throws(() => loadWorkflowDefinitions(dir), /must reference an earlier step/);
});

test("workflow definitions reject multiple active workflows", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-multiple-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        {
          id: "finance",
          version: 1,
          steps: [{ id: "PLAN_APPROVED", role: "producer", humanApproval: true, requiredSkills: [] }],
        },
        {
          id: "treasury",
          version: 1,
          steps: [{ id: "PLAN_APPROVED", role: "producer", humanApproval: true, requiredSkills: [] }],
        },
      ],
    }),
  );

  assert.throws(() => loadWorkflowDefinitions(dir), /supports exactly one active workflow/);
});
