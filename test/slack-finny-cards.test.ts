import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINNY_CLARIFICATION_OTHER_ACTION_ID,
  FINNY_PLAN_ACTION_IDS,
  finnyClarificationCard,
  finnyClarificationOptionActionId,
  finnyDecisionCard,
  finnyPlanCard,
  finnyResultCard,
} from "../src/slack/finny-cards.ts";

function actionsOf(card: { blocks: Array<Record<string, unknown>> }) {
  return card.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ action_id: string; value: string; text: { text: string }; style?: string }>;
  };
}

test("finnyPlanCard presents the T2 plan and explicit decisions", () => {
  const card = finnyPlanCard({
    requestId: "req_opaque_7",
    title: "October close and investor pack",
    summary: "Reconcile the close, certify the figures, and publish the approved pack.",
    phases: [
      { name: "Reconcile ledgers", owner: "Producer", dependencies: [] },
      { name: "Independent audit", owner: "Auditor", dependencies: ["Reconcile ledgers"] },
      { name: "Publish", owner: "Controller", dependencies: ["Independent audit"] },
    ],
    certification: "Independent Auditor PASS on all required checks",
    deliverable: "Certified October investor pack",
    destination: "#finance-ops in this thread",
  });

  const rendered = JSON.stringify(card.blocks);
  assert.match(card.text, /October close and investor pack/);
  assert.match(rendered, /Reconcile ledgers/);
  assert.match(rendered, /Producer/);
  assert.match(rendered, /Independent audit/);
  assert.match(rendered, /Auditor/);
  assert.match(rendered, /Depends on/);
  assert.match(rendered, /Independent Auditor PASS/);
  assert.match(rendered, /Certified October investor pack/);
  assert.match(rendered, /#finance-ops in this thread/);

  const actions = actionsOf(card).elements;
  assert.deepEqual(
    actions.map(({ text, action_id, value, style }) => [text.text, action_id, value, style]),
    [
      ["Approve", FINNY_PLAN_ACTION_IDS.approve, "req_opaque_7", "primary"],
      ["Reject", FINNY_PLAN_ACTION_IDS.reject, "req_opaque_7", "danger"],
      ["Request change", FINNY_PLAN_ACTION_IDS.requestChange, "req_opaque_7", undefined],
    ],
  );
  assert.ok(actions.every((action) => action.value === "req_opaque_7"));
  assert.doesNotMatch(JSON.stringify(actions), /digest|thread|caller|actor/i);
});

test("finnyPlanCard clips Block Kit text without splitting a surrogate pair", () => {
  const card = finnyPlanCard({
    requestId: "r1",
    title: `Quarter close ${"😀".repeat(200)}`,
    summary: "s".repeat(10_000),
    phases: [
      {
        name: "n".repeat(4_000) + "😀",
        owner: "o".repeat(4_000),
        dependencies: ["d".repeat(4_000)],
      },
    ],
    certification: "c".repeat(10_000),
    deliverable: "x".repeat(10_000),
    destination: "y".repeat(10_000),
  });

  for (const block of card.blocks as any[]) {
    if (block.type === "header") {
      assert.ok(block.text.text.length <= 150);
      assert.doesNotMatch(block.text.text, /\ud83d$/u);
    }
    if (block.type === "section") {
      assert.ok(block.text.text.length <= 3000);
      assert.doesNotMatch(block.text.text, /\ud83d$/u);
      for (const field of block.fields ?? []) assert.ok(field.text.length <= 2000);
    }
  }
  assert.ok(card.text.length <= 4000);
  assert.throws(
    () =>
      finnyPlanCard({
        requestId: "r2",
        title: "Too many phases",
        summary: "Summary",
        phases: Array.from({ length: 44 }, (_, index) => ({
          name: `Phase ${index}`,
          owner: "Owner",
          dependencies: [],
        })),
        certification: "PASS",
        deliverable: "Pack",
        destination: "Thread",
      }),
    /50-block message limit/,
  );
  const rendered = JSON.stringify(card.blocks);
  assert.match(rendered, /Certification/);
  assert.match(rendered, /Deliverable/);
  assert.match(rendered, /Destination/);
  assert.match(rendered, /Owner/);
  assert.match(rendered, /Depends on/);
});

test("finnyClarificationCard marks a recommendation without selecting a default", () => {
  const card = finnyClarificationCard({
    requestId: "clarify_42",
    question: "Which revenue recognition basis should the plan use?",
    recommendedOptionId: "signed-contracts",
    options: [
      { id: "signed-contracts", label: "Signed contracts", description: "Use executed agreements only." },
      { id: "invoices", label: "Issued invoices", description: "Use invoice date." },
    ],
  });

  const rendered = JSON.stringify(card.blocks);
  assert.match(rendered, /Which revenue recognition basis/);
  assert.match(rendered, /Recommended/);
  assert.match(rendered, /Use executed agreements only/);
  const actions = actionsOf(card).elements;
  assert.deepEqual(
    actions.map(({ text, action_id, value, style }) => [text.text, action_id, value, style]),
    [
      ["Signed contracts · Recommended", finnyClarificationOptionActionId("signed-contracts"), "clarify_42", "primary"],
      ["Issued invoices", finnyClarificationOptionActionId("invoices"), "clarify_42", undefined],
      ["Other", FINNY_CLARIFICATION_OTHER_ACTION_ID, "clarify_42", undefined],
    ],
  );
  assert.ok(actions.every((action) => action.value === "clarify_42"));
  assert.ok(actions.every((action: any) => action.selected === undefined && action.initial_option === undefined));
});

test("finnyClarificationCard rejects identifiers and option counts that exceed Slack bounds", () => {
  assert.throws(() => finnyClarificationOptionActionId(""), /option identifier/i);
  assert.throws(() => finnyClarificationOptionActionId("x".repeat(256)), /255/);
  assert.throws(
    () =>
      finnyClarificationCard({
        requestId: "r1",
        question: "Pick one",
        recommendedOptionId: "blank",
        options: [{ id: "blank", label: "   " }],
      }),
    /label/i,
  );
  assert.throws(
    () =>
      finnyClarificationCard({
        requestId: "r1",
        question: "Pick one",
        recommendedOptionId: "missing",
        options: [{ id: "present", label: "Present" }],
      }),
    /recommended option/i,
  );
  assert.throws(
    () =>
      finnyClarificationCard({
        requestId: "r1",
        question: "Pick one",
        recommendedOptionId: "same",
        options: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      }),
    /unique/i,
  );
  assert.throws(
    () =>
      finnyClarificationCard({
        requestId: "r1",
        question: "Pick one",
        recommendedOptionId: "o0",
        options: Array.from({ length: 25 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` })),
      }),
    /25 elements/i,
  );
});

test("decision and result helpers produce scan-friendly immutable cards", () => {
  const decision = finnyDecisionCard({
    title: "October close plan",
    decision: "request_change",
    detail: "Split tax certification into a separate phase.",
  });
  assert.match(decision.text, /Changes requested/);
  assert.match(JSON.stringify(decision.blocks), /Split tax certification/);
  assert.equal(
    decision.blocks.some((block) => block.type === "actions"),
    false,
  );

  const result = finnyResultCard({
    title: "October investor pack",
    status: "passed",
    summary: "All required checks passed against revision 4.",
    deliverable: "Certified investor pack",
    destination: "#finance-ops",
  });
  const rendered = JSON.stringify(result.blocks);
  assert.match(result.text, /Completed/);
  assert.match(rendered, /All required checks passed/);
  assert.match(rendered, /Certified investor pack/);
  assert.match(rendered, /#finance-ops/);
  assert.equal(
    result.blocks.some((block) => block.type === "actions"),
    false,
  );
});
