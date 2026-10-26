import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import { activitySeq } from "../src/items.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorkBlock } from "../src/core-bridge.ts";
import {
  messageWorkTimeline,
  currentTextPhase,
  streamedAnswer,
  streamingTextTail,
  buildTimeline,
  workTimelineSegments,
  toolCategory,
  toolRowKind,
  toolExecutionOutput,
  type ToolRowModel,
} from "../src/timeline.ts";

function row(call: Item, result?: Item): ToolRowModel {
  return { call, result: result ?? null };
}

test("thinking, tool calls, and results stay in seq order — never bucketed by type", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("Reasoning", { seq: 1, createdAt: 1, text: "first I'll look" }) },
      { item: item("ToolCall", { seq: 2, createdAt: 2, tool: "execute", body: { command: "ls" } }) },
      { item: item("ToolResult", { seq: 3, createdAt: 3, tool: "execute", body: { code: 0 } }) },
      { item: item("Reasoning", { seq: 4, createdAt: 4, text: "now read it" }) },
      { item: item("ToolCall", { seq: 5, createdAt: 5, tool: "read", body: { path: "/x" } }) },
      { item: item("ToolResult", { seq: 6, createdAt: 6, tool: "read" }) },
    ],
  };
  const items = buildTimeline(work);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["thinking", "tool", "thinking", "tool"],
    "two thinking blocks interleave between the two tool rows, in arrival order",
  );
  assert.equal(items[0].kind === "thinking" && items[0].text, "first I'll look");
  assert.ok(
    items[1].kind === "tool" && items[1].row.call && items[1].row.result,
    "the first tool row pairs its call with its result",
  );
});

test("a paused command's approval marker attaches to its blocked tool row", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "rm -rf x" } }) },
      {
        item: item("ToolResult", {
          seq: 2,
          createdAt: 2,
          tool: "execute",
          body: { blocked: "needs_approval", reason: "recursive delete" },
        }),
      },
    ],
    pendingApprovals: [{ requestId: "r1", command: "rm -rf x", reason: "recursive delete" }],
  };
  const items = buildTimeline(work);
  assert.equal(items.length, 1, "no separate approval item — the marker rides the blocked tool row");
  assert.ok(items[0].kind === "tool" && items[0].row.pending?.requestId === "r1");
});

test("a command approval's plain-English summary survives onto the timeline item for the renderer", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "rm -rf x" } }) },
      {
        item: item("ToolResult", {
          seq: 2,
          createdAt: 2,
          tool: "execute",
          body: { blocked: "needs_approval", reason: "recursive delete" },
        }),
      },
    ],
    pendingApprovals: [
      {
        requestId: "r1",
        command: "rm -rf x",
        reason: "recursive delete",
        summary: "Deletes the x/ directory and everything inside it.",
      },
    ],
  };
  const items = buildTimeline(work);
  assert.ok(
    items[0].kind === "tool" && items[0].row.pending?.summary === "Deletes the x/ directory and everything inside it.",
  );
  assert.ok(items[0].kind === "tool" && items[0].row.pending?.reason === "recursive delete");
});

test("an approval whose tool_call isn't in the loaded activity lands at the end", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "ls" } }) },
      { item: item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", body: { code: 0 } }) },
    ],
    pendingApprovals: [{ requestId: "r9", command: "deploy prod", reason: "ship it" }],
  };
  const items = buildTimeline(work);
  assert.equal(items.length, 2, "the tool row plus a trailing fallback approval");
  assert.equal(items[1].kind, "approval");
  assert.ok(items[1].kind === "approval" && items[1].approval.requestId === "r9");
});

test("two distinct paused commands each get their own approval marker", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "git clone a" } }) },
      {
        item: item("ToolResult", {
          seq: 2,
          createdAt: 2,
          tool: "execute",
          body: { blocked: "needs_approval", reason: "clone" },
        }),
      },
      { item: item("ToolCall", { seq: 3, createdAt: 3, tool: "execute", body: { command: "git clone b" } }) },
      {
        item: item("ToolResult", {
          seq: 4,
          createdAt: 4,
          tool: "execute",
          body: { blocked: "needs_approval", reason: "clone" },
        }),
      },
    ],
    pendingApprovals: [
      { requestId: "ra", command: "git clone a" },
      { requestId: "rb", command: "git clone b" },
    ],
  };
  const items = buildTimeline(work);
  assert.equal(items.length, 2, "two tool rows, each carrying its own marker — none left over at the end");
  assert.ok(items[0].kind === "tool" && items[0].row.pending?.requestId === "ra");
  assert.ok(items[1].kind === "tool" && items[1].row.pending?.requestId === "rb");
});

test("on a finished turn, retried identical orphan calls fold into one row with a count", () => {
  const work: WorkBlock = {
    status: "failed",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "flaky" } }) },
      { item: item("ToolCall", { seq: 2, createdAt: 2, tool: "execute", body: { command: "flaky" } }) },
      { item: item("ToolCall", { seq: 3, createdAt: 3, tool: "execute", body: { command: "flaky" } }) },
    ],
  };
  const items = buildTimeline(work);
  assert.equal(items.length, 1);
  assert.ok(items[0].kind === "tool" && items[0].row.attempts === 3);
});

test("interleaved thinking breaks an orphan-call run so the rows aren't fused", () => {
  const work: WorkBlock = {
    status: "failed",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "flaky" } }) },
      { item: item("Reasoning", { seq: 2, createdAt: 2, text: "hmm" }) },
      { item: item("ToolCall", { seq: 3, createdAt: 3, tool: "execute", body: { command: "flaky" } }) },
    ],
  };
  const items = buildTimeline(work);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["tool", "thinking", "tool"],
    "the thinking between the two identical calls keeps them as separate rows",
  );
});

test("interstitial narration (text) interleaves with thinking and tools by seq", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("Reasoning", { seq: 1, createdAt: 1, text: "plan" }) },
      {
        item: item("AgentMessage", {
          seq: 2,
          createdAt: 2,
          variant: "narration",
          text: "Let me check the config first.",
        }),
      },
      { item: item("ToolCall", { seq: 3, createdAt: 3, tool: "read", body: { path: "/cfg" } }) },
      { item: item("ToolResult", { seq: 4, createdAt: 4, tool: "read" }) },
    ],
  };
  const items = buildTimeline(work);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["thinking", "text", "tool"],
    "narration sits between the thinking and the tool it precedes",
  );
  assert.ok(items[1].kind === "text" && items[1].item.text?.startsWith("Let me check"));
});

test("results pair to their call by callId across batched (parallel) tool calls", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      {
        item: item("ToolCall", { seq: 3, createdAt: 3, tool: "execute", callId: "A", body: { command: "echo first" } }),
      },
      {
        item: item("ToolCall", {
          seq: 4,
          createdAt: 4,
          tool: "execute",
          callId: "B",
          body: { command: "echo second" },
        }),
      },
      {
        item: item("ToolCall", { seq: 5, createdAt: 5, tool: "execute", callId: "C", body: { command: "echo third" } }),
      },
      { item: item("ToolResult", { seq: 6, createdAt: 6, tool: "execute", callId: "B", body: { code: 0 } }) },
      {
        item: item("ToolCall", { seq: 9, createdAt: 9, tool: "execute", callId: "D", body: { command: "echo first" } }),
      },
      {
        item: item("ToolCall", {
          seq: 10,
          createdAt: 10,
          tool: "execute",
          callId: "E",
          body: { command: "echo third" },
        }),
      },
      { item: item("ToolResult", { seq: 11, createdAt: 11, tool: "execute", callId: "D", body: { code: 0 } }) },
      { item: item("ToolResult", { seq: 12, createdAt: 12, tool: "execute", callId: "E", body: { code: 0 } }) },
    ],
  };
  const items = buildTimeline(work);
  assert.equal(items.length, 5, "five tool rows, no stray orphan-result row");
  assert.ok(items.every((i) => i.kind === "tool"));
  const rows = items.map((i) => (i.kind === "tool" ? i.row : null));
  assert.ok(rows[0]!.call && !rows[0]!.result, "echo first (batch 1) stays resultless");
  assert.ok(rows[1]!.result && rows[1]!.result.callId === "B", "echo second got result B, not C's");
  assert.ok(rows[2]!.call && !rows[2]!.result, "echo third (batch 1) stays resultless");
  assert.ok(rows[3]!.result && rows[3]!.result.callId === "D", "retried echo first got result D");
  assert.ok(rows[4]!.result && rows[4]!.result.callId === "E", "retried echo third got result E");
});

test("toolRowKind: a successful result is `ok`", () => {
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "publish", body: { name: "site" } }),
        item("ToolResult", { seq: 2, createdAt: 2, tool: "publish", body: { url: "https://x" } }),
      ),
      "complete",
    ),
    "ok",
  );
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "ls" } }),
        item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", body: { code: 0 } }),
      ),
      "complete",
    ),
    "ok",
  );
});

test("toolRowKind: an error result is `failed`, regardless of which tool", () => {
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "publish", body: { name: ":bad" } }),
        item("ToolResult", { seq: 2, createdAt: 2, tool: "publish", body: { error: "invalid deployment name" } }),
      ),
      "complete",
    ),
    "failed",
  );
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "write", body: { path: "/x" } }),
        item("ToolResult", { seq: 2, createdAt: 2, tool: "write", body: { error: "EACCES" } }),
      ),
      "complete",
    ),
    "failed",
  );
});

test("toolRowKind: a policy-denied command is `failed`, and a nonzero exit is `ok`", () => {
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "curl evil" } }),
        item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", body: { denied: true, reason: "blocked host" } }),
      ),
      "complete",
    ),
    "failed",
  );
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "false" } }),
        item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", body: { code: 1 } }),
      ),
      "complete",
    ),
    "ok",
  );
});

test("toolRowKind: a needs-approval result is `approval`", () => {
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", body: { command: "rm -rf x" } }),
        item("ToolResult", {
          seq: 2,
          createdAt: 2,
          tool: "execute",
          body: { blocked: "needs_approval", reason: "recursive delete" },
        }),
      ),
      "working",
    ),
    "approval",
  );
});

test("toolRowKind: no result yet — `running` mid-turn, `attempted`/`failed` once the turn ends", () => {
  assert.equal(
    toolRowKind(row(item("ToolCall", { seq: 1, createdAt: 1, tool: "publish", body: { name: "site" } })), "working"),
    "running",
    "mid-turn, still in flight",
  );
  assert.equal(
    toolRowKind(row(item("ToolCall", { seq: 1, createdAt: 1, tool: "publish", body: { name: "site" } })), "complete"),
    "attempted",
    "turn finished cleanly but we never heard back — orphan, not a failure",
  );
  assert.equal(
    toolRowKind(row(item("ToolCall", { seq: 1, createdAt: 1, tool: "publish", body: { name: "site" } })), "failed"),
    "failed",
    "turn itself failed, so the in-flight call counts as failed",
  );
});

function workWith(activity: Item[], status: WorkBlock["status"] = "working"): WorkBlock {
  return { status, activity: activity.map((entry) => ({ item: entry })) };
}

test("buildTimeline is memoized: unchanged (activity, status, approvals) returns the identical array", () => {
  const work = workWith([
    item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", callId: "a", body: { command: "ls" } }),
  ]);
  const first = buildTimeline(work);
  assert.equal(buildTimeline(work), first, "same inputs must hit the memo");
});

test("the memo misses when activity is replaced, status flips, or approvals change", () => {
  const a1 = [item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", callId: "a", body: { command: "ls" } })];
  const work = workWith(a1);
  const first = buildTimeline(work);

  work.activity = [
    ...work.activity,
    { item: item("ToolResult", { seq: 2, createdAt: 2, tool: "execute", callId: "a" }) },
  ];
  const second = buildTimeline(work);
  assert.notEqual(second, first, "replaced activity must rebuild");
  assert.equal(buildTimeline(work), second, "and re-memoize");

  work.status = "complete";
  const third = buildTimeline(work);
  assert.notEqual(third, second, "a status change must rebuild (it drives collapsing)");

  work.pendingApprovals = [{ requestId: "r1", command: "rm -rf /", createdAt: 3 } as never];
  const fourth = buildTimeline(work);
  assert.notEqual(fourth, third, "changed approvals must rebuild");
});

test("memoized output still reflects a mutated-then-replaced work correctly", () => {
  const work = workWith([item("Reasoning", { seq: 1, createdAt: 1, text: "hm" })], "working");
  assert.equal(buildTimeline(work).length, 1);
  work.activity = [
    { item: item("Reasoning", { seq: 1, createdAt: 1, text: "hm" }) },
    { item: item("ToolCall", { seq: 2, createdAt: 2, tool: "read", callId: "b", body: { path: "x" } }) },
  ];
  const items = buildTimeline(work);
  assert.equal(items.length, 2);
  assert.equal(items[1]?.kind, "tool");
});

test("unified sandbox execution keeps legacy failure and display semantics", () => {
  for (const [tool, body] of [
    ["execute", {}],
    ["sandbox", { action: "exec" }],
  ] as const) {
    const call = item("ToolCall", { seq: 1, createdAt: 1, tool, body });
    const result = (fields: Parameters<typeof item>[1]) =>
      item("ToolResult", { seq: 2, createdAt: 2, tool, ...fields, body: { ...body, ...fields?.body } });
    assert.equal(toolCategory(tool, body), "execute");
    assert.equal(toolRowKind(row(call, result({ text: "failed\n[exit 1]", body: { code: 1 } })), "complete"), "ok");
    assert.equal(toolRowKind(row(call, result({ text: "ok\n[exit 0]", body: { code: 0 } })), "complete"), "ok");
    assert.equal(
      toolRowKind(
        row(call, result({ text: "failed\n[exit 1]", isError: true, body: { code: 1, timedOut: false } })),
        "complete",
      ),
      "ok",
    );
    assert.equal(toolRowKind({ call: null, result: result({ body: { code: 2 } }) }, "complete"), "ok");
  }
  for (const action of [
    "start_process",
    "read_process",
    "write_stdin",
    "signal_process",
    "list_processes",
    "watch_process",
    "unwatch_process",
  ])
    assert.equal(toolCategory("sandbox", { action }), "background");
  assert.equal(toolCategory("sandbox", { action: "status" }), "sandbox");
});

test("different sandbox actions and process targets do not collapse into one orphan attempt", () => {
  const actions = [
    { action: "status", sandbox_id: "box-a" },
    { action: "restart", sandbox_id: "box-a" },
    { action: "status", sandbox_id: "box-b" },
    { action: "read_process", process_id: "job-a" },
    { action: "read_process", process_id: "job-b" },
  ];
  const items = buildTimeline({
    status: "complete",
    activity: actions.map((action, index) => ({
      item: item("ToolCall", { seq: index, createdAt: index, tool: "sandbox", body: { ...action } }),
    })),
  });
  assert.equal(items.length, actions.length);
});

test("unscreened execution retains its warning and neutral exit status without parsing command text", () => {
  const result = item("ToolResult", {
    seq: 2,
    createdAt: 2,
    tool: "sandbox",
    text: "[NOT security-screened]\nQA_EXPECTED_FAILURE\n[exit 7]",
    isError: false,
    body: { action: "exec", code: 7, timedOut: false, unscreened: true },
  });
  const call = item("ToolCall", {
    seq: 1,
    createdAt: 1,
    tool: "sandbox",
    body: { action: "exec", sandbox_id: "box-a" },
  });
  assert.equal(toolRowKind(row(call, result), "complete"), "ok");
  assert.equal(toolExecutionOutput(result), result.text);
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "execute" }),
        item("ToolResult", {
          seq: 2,
          createdAt: 2,
          text: "fake [exit 7]\n[exit 0]",
          isError: false,
          body: { code: 0 },
        }),
      ),
      "complete",
    ),
    "ok",
  );
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "execute" }),
        item("ToolResult", { seq: 2, createdAt: 2, body: { code: 0, timedOut: true } }),
      ),
      "complete",
    ),
    "failed",
  );
  assert.equal(
    toolExecutionOutput(item("ToolResult", { text: "done\n[exit 0]", body: { code: 0 } })),
    "done\n[exit 0]",
  );
  assert.equal(toolExecutionOutput(item("ToolResult", { text: "[tool output quarantined]", isError: true })), null);
  assert.equal(
    toolRowKind(
      row(
        item("ToolCall", { seq: 1, createdAt: 1, tool: "sandbox", body: { action: "exec" } }),
        item("ToolResult", { seq: 2, createdAt: 2, text: "[tool output quarantined]", isError: true }),
      ),
      "complete",
    ),
    "failed",
  );
});

test("recorded narration is consumed once per occurrence while the next block streams", () => {
  const text = "Checking.";
  const activity = [
    { item: item("AgentMessage", { seq: 1, createdAt: 1, variant: "narration", text: text }) },
    { item: item("ToolCall", { seq: 2, createdAt: 2, tool: "lookup" }) },
  ];
  assert.equal(streamingTextTail(text + "\n\n" + text, activity), text);
  activity.push(
    { item: item("ToolResult", { seq: 3, createdAt: 3, tool: "lookup" }) },
    { item: item("AgentMessage", { seq: 4, createdAt: 4, variant: "narration", text: text }) },
  );
  assert.equal(streamingTextTail(text + "\n\n" + text + "\n\nFinal", activity), "Final");
  assert.equal(streamingTextTail("Check", activity), "");
  assert.equal(streamingTextTail("Different reply", activity), "Different reply");
  assert.equal(streamingTextTail("    indented code", []), "    indented code");
});

test("one work timeline includes initial and repeated narration but excludes the authoritative final occurrence", () => {
  const activity = [
    item("AgentMessage", { seq: 1, createdAt: 1, variant: "narration", text: "Same" }),
    item("ToolCall", { seq: 2, createdAt: 2, tool: "lookup", callId: "a" }),
    item("AgentMessage", { seq: 3, createdAt: 3, variant: "narration", text: "Same" }),
    item("ToolResult", { seq: 4, createdAt: 4, tool: "lookup", callId: "a" }),
    item("AgentMessage", { seq: 5, createdAt: 5, variant: "narration", text: "Same" }),
  ].map((entry) => ({ item: entry }));
  const work: WorkBlock = { status: "complete", activity };
  const items = messageWorkTimeline(work, "Same");
  assert.deepEqual(
    items.map((item) => item.kind),
    ["text", "tool", "text"],
  );
  assert.equal(activity.length, 5);
  assert.equal(messageWorkTimeline({ ...work, status: "working" }, "").length, 4);
});

test("work projection omits empty and redacted thinking without changing parallel tool pairing", () => {
  const work: WorkBlock = {
    status: "failed",
    activity: [
      { item: item("Reasoning", { seq: 1, createdAt: 1, text: "secret", body: { redacted: true } }) },
      { item: item("Reasoning", { seq: 2, createdAt: 2, text: " " }) },
      { item: item("ToolCall", { seq: 3, createdAt: 3, tool: "a", callId: "a" }) },
      { item: item("ToolCall", { seq: 4, createdAt: 4, tool: "b", callId: "b" }) },
      { item: item("ToolResult", { seq: 5, createdAt: 5, callId: "b" }) },
      { item: item("ToolResult", { seq: 6, createdAt: 6, callId: "a" }) },
    ],
  };
  const items = messageWorkTimeline(work, "");
  assert.deepEqual(
    items.map((item) => item.kind),
    ["tool", "tool"],
  );
  assert.equal(items[0]?.kind === "tool" && items[0].row.result?.seq, 6);
  assert.equal(items[1]?.kind === "tool" && items[1].row.result?.seq, 5);
});

test("explicit commentary remains folded even when the final answer repeats it", () => {
  const activity = [
    {
      item: item("AgentMessage", {
        seq: 1,
        createdAt: 1,
        variant: "narration",
        text: "Same",
        body: { phase: "commentary" },
      }),
    },
  ];
  assert.equal(messageWorkTimeline({ status: "complete", activity }, "Same").length, 1);
});

test("explicit public phases use offsets and never appear as tool rows", () => {
  const work: WorkBlock = {
    status: "working",
    activity: [
      {
        item: item("AgentMessage", {
          seq: 1,
          createdAt: 1,
          variant: "narration",
          text: "Same words",
          body: { phase: "commentary" },
        }),
      },
      { marker: "text_start", seq: 2, createdAt: 2, phase: "final_answer", streamOffset: 12 },
    ],
  };
  assert.deepEqual(currentTextPhase(work), { phase: "final_answer", streamOffset: 12, startedAt: 2 });
  assert.deepEqual(
    buildTimeline(work).map((item) => item.kind),
    ["text"],
  );
  work.activity.push({ marker: "text_start", seq: 3, createdAt: 3, phase: "commentary", streamOffset: 24 });
  assert.equal(currentTextPhase(work)?.phase, "commentary");
  work.activity.push({ marker: "text_start", seq: 4, createdAt: 4, phase: "final_answer", streamOffset: -1 });
  assert.equal(currentTextPhase(work), null);
});

test("stopped stream projection uses the final boundary even when final text repeats commentary", () => {
  const work: WorkBlock = {
    status: "working",
    activity: [
      {
        item: item("AgentMessage", {
          seq: 1,
          createdAt: 1,
          variant: "narration",
          text: "Same words",
          body: { phase: "commentary" },
        }),
      },
      { marker: "text_start", seq: 2, createdAt: 2, phase: "final_answer", streamOffset: 12 },
    ],
  };
  assert.equal(streamedAnswer("Same words\n\nSame words again", work), "Same words again");
});

test("steering splits visible work without breaking a tool that completes across intake", () => {
  const work: WorkBlock = {
    status: "working",
    activity: [
      { item: item("ToolCall", { seq: 1, createdAt: 1, tool: "execute", callId: "a", body: { command: "first" } }) },
      { item: item("SteeringMessage", { seq: 2, createdAt: 2, text: "Change direction" }) },
      { item: item("ToolResult", { seq: 3, createdAt: 3, tool: "execute", callId: "a", body: { code: 0 } }) },
      { item: item("ToolCall", { seq: 4, createdAt: 4, tool: "execute", callId: "b", body: { command: "second" } }) },
      { item: item("SteeringMessage", { seq: 5, createdAt: 5, text: "Keep it brief" }) },
    ],
  };
  const segments = workTimelineSegments(buildTimeline(work));
  assert.deepEqual(
    segments.map((items) => items.map((item) => item.kind)),
    [["tool"], ["steer"], ["tool"], ["steer"], []],
  );
  const first = segments[0]![0]!;
  assert.ok(first.kind === "tool");
  assert.equal(first.row.call?.seq, 1);
  assert.equal(first.row.result?.seq, 3);
  assert.equal(toolRowKind(first.row, work.status), "ok");
  assert.deepEqual(work.activity.map(activitySeq), [1, 2, 3, 4, 5]);
});

test("ordinary and hidden user events do not become steering markers", () => {
  const work: WorkBlock = {
    status: "complete",
    activity: [
      { item: item("UserMessage", { seq: 1, createdAt: 1, text: "ordinary" }) },
      { item: item("UserMessage", { seq: 2, createdAt: 2, text: "hidden", hidden: true }) },
    ],
  };
  assert.deepEqual(buildTimeline(work), []);
});

test("detached execution uses process presentation rather than foreground output suppression", () => {
  assert.equal(toolCategory("execute", { background: true }), "background");
  assert.equal(toolCategory("execute", { background: false }), "execute");
});

test("trimmed phases show whole-word tails and newer phases retain absolute boundaries", () => {
  const work: WorkBlock = {
    status: "working",
    streamStartOffset: 101,
    activity: [{ marker: "text_start", seq: 1, createdAt: 1, phase: "final_answer", streamOffset: 80 }],
  };
  assert.equal(streamedAnswer("ipped word here", work), "…earlier output omitted\n\nword here");
  assert.equal(streamedAnswer("unbroken", work), "…earlier output omitted\n\n");
  work.activity = [{ marker: "text_start", seq: 2, createdAt: 2, phase: "final_answer", streamOffset: 107 }];
  assert.equal(streamedAnswer("older New answer", work), "New answer");
});

test("recorded commentary is not repeated after its live window is trimmed", () => {
  const work: WorkBlock = {
    status: "working",
    streamStartOffset: 101,
    activity: [{ marker: "text_start", seq: 1, createdAt: 1, phase: "commentary", streamOffset: 80 }],
  };
  assert.equal(streamedAnswer("ipped word here", work), "…earlier output omitted\n\nword here");
  work.activity.push({
    item: item("AgentMessage", {
      seq: 2,
      createdAt: 2,
      variant: "narration",
      text: "The whole commentary is now recorded.",
    }),
  });
  assert.equal(streamedAnswer("ipped word here", work), "");
});

test("live reasoning renders as a trailing thinking row until its persisted entry arrives or work ends", () => {
  const reasoning = [
    { step: "s1", index: 0, text: "**Checking** the cache" },
    { step: "s1", index: 2, text: "   " },
  ];
  const work: WorkBlock = {
    status: "working",
    activity: [
      {
        item: item("Reasoning", {
          seq: 1,
          createdAt: 1,
          text: "earlier",
          step: 0,
          body: { wire: { message: { id: "s0" } } },
        }),
      },
    ],
    reasoning,
  };
  const live = buildTimeline(work);
  assert.deepEqual(
    live.map((item) => (item.kind === "thinking" ? item.text : item.kind)),
    ["earlier", "**Checking** the cache"],
  );
  const persisted: WorkBlock = {
    ...work,
    activity: [
      ...work.activity,
      {
        item: item("Reasoning", {
          seq: 2,
          createdAt: 2,
          text: "**Checking** the cache",
          step: 0,
          body: { wire: { message: { id: "s1" } } },
        }),
      },
    ],
  };
  assert.equal(buildTimeline(persisted).length, 2, "the persisted entry replaces the live row instead of doubling it");
  const otherBlock: WorkBlock = {
    ...work,
    activity: [
      ...work.activity,
      {
        item: item("Reasoning", {
          seq: 2,
          createdAt: 2,
          text: "other",
          step: 1,
          body: { wire: { message: { id: "s1" } } },
        }),
      },
    ],
  };
  assert.equal(buildTimeline(otherBlock).length, 3, "a different block of the same step does not hide this one");
  assert.equal(buildTimeline({ ...work, status: "complete" }).length, 1, "finished work shows only durable rows");
});

test("NULL legacy call IDs preserve the existing adjacent-result fallback", () => {
  for (const callId of [null, "known-call"]) {
    const work: WorkBlock = {
      status: "complete",
      activity: [
        {
          item: item("ToolCall", {
            seq: 10,
            createdAt: 10,
            tool: "execute",
            callId: callId,
            body: { command: "echo hello" },
          }),
        },
        {
          item: item("ToolResult", {
            seq: 11,
            createdAt: 11,
            tool: "execute",
            callId: null,
            text: "hello",
            body: { code: 0 },
          }),
        },
      ],
    };
    const timeline = buildTimeline(work);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].kind, "tool");
    if (timeline[0].kind !== "tool") throw new Error("expected paired tool row");
    assert.equal(timeline[0].row.call?.seq, 10);
    assert.equal(timeline[0].row.result?.seq, 11);
    assert.equal(toolRowKind(timeline[0].row, work.status), "ok");
  }
});
