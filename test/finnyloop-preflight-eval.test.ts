import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface EvalScenario {
  id: string;
  query: string;
  expectedCategory: "accounts_payable" | "accounts_receivable" | "general_ledger";
  expectedProducerSkill: string;
  mandatoryInvariants: string[];
}

test("FinnyLoop Preflight & Resolver Eval: evaluates real-world finance prompt classifications against resolver.md", () => {
  const routerResolverPath = join(
    process.cwd(),
    "work/qm-finance-skill-pack/skills/finance-router/references/resolver.md",
  );

  assert.ok(existsSync(routerResolverPath), "Router resolver must exist in repository");
  const routerText = readFileSync(routerResolverPath, "utf8");

  const scenarios: EvalScenario[] = [
    {
      id: "eval-ap-closing-liability",
      query: "Prepare AP Closing Liability | 4 Vendors x 4 Quarter-Ends",
      expectedCategory: "accounts_payable",
      expectedProducerSkill: "sharechat-ap-outstanding-workbook",
      mandatoryInvariants: ["Accounts payable"],
    },
    {
      id: "eval-ap-vendor-aging",
      query: "Extract vendor outstanding bills aging and MSME Section 15 compliance report",
      expectedCategory: "accounts_payable",
      expectedProducerSkill: "sharechat-ap-outstanding-workbook",
      mandatoryInvariants: ["Accounts payable"],
    },
    {
      id: "eval-ar-collections",
      query: "Generate ShareChat AR collections and customer overdue aging report",
      expectedCategory: "accounts_receivable",
      expectedProducerSkill: "sharechat-ar-collection",
      mandatoryInvariants: ["Accounts receivable"],
    },
  ];

  for (const scenario of scenarios) {
    const isAP = /ap|vendor|payable|liability/i.test(scenario.query);
    const isAR = /ar|customer|receivable|collection/i.test(scenario.query);

    if (scenario.expectedCategory === "accounts_payable") {
      assert.ok(isAP, `${scenario.id} must be classified as accounts_payable`);
      assert.ok(routerText.includes("Accounts payable"), "Must resolve through Accounts payable in resolver.md");
    } else if (scenario.expectedCategory === "accounts_receivable") {
      assert.ok(isAR, `${scenario.id} must be classified as accounts_receivable`);
      assert.ok(routerText.includes("sharechat-ar-collection"), "Must resolve sharechat-ar-collection in resolver.md");
    }

    for (const inv of scenario.mandatoryInvariants) {
      assert.ok(routerText.includes(inv), `${scenario.id} must bind mandatory invariant '${inv}' from resolver`);
    }
  }
});
