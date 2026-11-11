import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGenerativeUISpec, renderGenerativeUI } from "../src/slack/generative-ui.ts";

test("parseGenerativeUISpec detects and parses generative-ui.v1 JSON specs", () => {
  const json = JSON.stringify({
    schema: "generative-ui.v1",
    fallbackText: "Reconciliation Plan",
    elements: [
      { type: "header", text: "AP Ageing Analysis" },
      { type: "section", text: "Verified *4 vendors* across 3 cutoffs." },
      { type: "divider" },
      {
        type: "fields",
        fields: [
          { title: "Status", value: "Complete" },
          { title: "Total Amount", value: "$1,240,500" },
        ],
      },
      {
        type: "table",
        headers: ["Vendor", "Cutoff", "Balance"],
        rows: [
          ["Visionular", "31-Mar-2026", "$450,000"],
          ["Notion", "30-Jun-2026", "$320,000"],
        ],
      },
      {
        type: "actions",
        buttons: [
          { label: "Approve", actionId: "approve_plan", value: "plan_123", style: "primary" },
          { label: "Reject", actionId: "reject_plan", value: "plan_123", style: "danger" },
        ],
      },
      {
        type: "progress",
        title: "Reconciling Transactions",
        status: "in_progress",
        percentage: 65,
        step: "Querying NetSuite line links",
      },
      {
        type: "context",
        elements: ["Independent audit pending", "Report generated automatically"],
      },
    ],
  });

  const parsed = parseGenerativeUISpec(json);
  assert.ok(parsed);
  assert.equal(parsed.fallbackText, "Reconciliation Plan");
  assert.equal(parsed.elements.length, 8);

  const rendered = renderGenerativeUI(parsed);
  assert.equal(rendered.text, "Reconciliation Plan");
  assert.ok(rendered.blocks.length >= 6);

  const blockTypes = rendered.blocks.map((b) => b.type);
  assert.ok(blockTypes.includes("header"));
  assert.ok(blockTypes.includes("section"));
  assert.ok(blockTypes.includes("divider"));
  assert.ok(blockTypes.includes("actions"));
  assert.ok(blockTypes.includes("context"));
  const actionBlock = rendered.blocks.find((b) => b.type === "actions") as { elements: Array<{ action_id: string }> };
  assert.ok(actionBlock);
  assert.ok(actionBlock.elements[0]!.action_id.startsWith("gen_ui:"));
});

test("parseGenerativeUISpec filters out malformed elements cleanly without throwing", () => {
  const malformed = JSON.stringify({
    schema: "generative-ui.v1",
    elements: [
      null,
      {},
      { type: "header" },
      { type: "section", text: "Valid section" },
      { type: "table", headers: "not-array" },
    ],
  });
  const parsed = parseGenerativeUISpec(malformed);
  assert.ok(parsed);
  assert.equal(parsed.elements.length, 1);
  assert.equal(parsed.elements[0]!.type, "section");
});
test("parseGenerativeUISpec returns null on plain text or non-generative content", () => {
  assert.equal(parseGenerativeUISpec("Hello world!"), null);
  assert.equal(parseGenerativeUISpec(""), null);
  assert.equal(parseGenerativeUISpec('{"schema":"other.v1","elements":[]}'), null);
});
