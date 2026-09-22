import assert from "node:assert/strict";
import test from "node:test";
import {
  activityDescription,
  activityGroupSummary,
  activityGroups,
  activityLabel,
  thinkingPresentation,
  sessionPresentation,
} from "../src/activity-presentation.ts";
import type { ToolRowModel, ToolPayload, TimelineItem } from "../src/timeline.ts";

function row(command: string, result: ToolPayload | null = { code: 0 }): ToolRowModel {
  return {
    call: {
      seq: 1,
      parentSeq: null,
      type: "tool_call",
      payload: { tool: "sandbox", action: "exec", command },
      createdAt: 1,
    },
    result: result ? { seq: 2, parentSeq: null, type: "tool_result", payload: result, createdAt: 2 } : null,
  };
}

test("simple shell reads and searches get semantic labels, compound commands stay exact", () => {
  assert.equal(activityLabel(row("cat /workspace/src/main.ts"), "complete"), "main.ts");
  assert.equal(activityLabel(row("rg -n 'gateway' src/main.ts"), "complete"), "Searched for gateway in main.ts");
  for (const command of [
    "cat file; rm file",
    "rg foo src | head -10",
    "cat $(find .)",
    "rg -g '*.ts' foo src",
    "python3 <<'PY'\nprint(1)\nPY",
  ]) {
    assert.equal(activityDescription({ tool: "execute", command }).category, "execute");
  }
  assert.equal(
    activityLabel(row("rg -n 'gateway|secret' src/main.ts"), "complete"),
    "Searched for gateway|secret in main.ts",
  );
  assert.equal(activityLabel(row("sed -n '1,120p' src/main.ts"), "complete"), "main.ts");
  assert.equal(activityLabel(row("rg --files src"), "complete"), "Searched for files in src");
  assert.deepEqual(activityDescription({ tool: "skill", name: "publish" }), {
    category: "read",
    target: "publish/SKILL.md",
  });
  assert.deepEqual(activityDescription({ tool: "skill", name: "publish", path: "templates/x.md" }), {
    category: "read",
    target: "publish/x.md",
  });
});

test("status labels never report missing or failed results as successful", () => {
  assert.equal(activityLabel(row("npm test", null), "working"), "Running npm test");
  assert.equal(activityLabel(row("npm test", null), "complete"), "Tried running npm test");
  assert.equal(activityLabel(row("cat missing", { code: 1 }), "complete"), "Failed to read missing");
  assert.equal(activityLabel(row("npm test", { blocked: "needs_approval" }), "working"), null);
});

test("groups describe categories and surface errors and approvals", () => {
  const items: TimelineItem[] = [
    { kind: "tool", row: row("cat README.md") },
    { kind: "tool", row: row("npm test") },
  ];
  assert.deepEqual(activityGroupSummary(items, "complete"), {
    label: "Read files, ran commands",
    category: "read",
    attention: false,
  });
  items.push({ kind: "tool", row: row("false", { code: 1 }) });
  assert.equal(activityGroupSummary(items, "complete").attention, true);
  assert.match(activityGroupSummary(items, "complete").label, /1 failed/);
  items.push({ kind: "tool", row: row("run", { blocked: "needs_approval" }) });
  assert.doesNotMatch(activityGroupSummary(items, "working").label, /Approval needed/);
});

test("thinking titles become disclosure labels without repeating the heading", () => {
  for (const heading of ["**Organizing the setup**", "## Organizing the setup", "__Organizing the setup__"]) {
    assert.deepEqual(thinkingPresentation(`${heading}\n\nBody text`), {
      title: "Organizing the setup",
      body: "Body text",
    });
  }
  assert.deepEqual(thinkingPresentation("A thought without a heading"), {
    title: "Thought process",
    body: "A thought without a heading",
  });
  assert.equal(thinkingPresentation("**Bold** inside a sentence").title, "Thought process");
});

test("session actions identify their recipient and retain failure state", () => {
  const tool = row("");
  tool.call!.payload = {
    tool: "session",
    action: "send_message",
    target: "compaction-exact",
    text: "Check the remaining tests",
  };
  assert.deepEqual(sessionPresentation(tool, "complete"), {
    label: "Sent message to",
    target: "compaction-exact",
    preview: "Check the remaining tests",
  });
  tool.result!.payload = { isError: true };
  assert.equal(sessionPresentation(tool, "complete")?.label, "Failed to send message to");
  tool.call!.payload = { tool: "session", action: "open", name: "worker" };
  tool.result!.payload = { title: "Named worker", sessionId: "id" };
  assert.equal(sessionPresentation(tool, "complete")?.target, "Named worker");
});

test("activity grouping preserves speech boundaries and chronological item identity", () => {
  const tool: TimelineItem = { kind: "tool", row: row("npm test") };
  const speech: TimelineItem = {
    kind: "text",
    activity: { seq: 8, parentSeq: null, type: "text", payload: { text: "Checking" }, createdAt: 2 },
  };
  const thought: TimelineItem = {
    kind: "thinking",
    activity: { seq: 9, parentSeq: null, type: "thinking", payload: { thinking: "**Check**\nDetails" }, createdAt: 3 },
  };
  assert.deepEqual(activityGroups([tool, speech, thought, tool]), [[tool], [speech], [thought, tool]]);
  assert.deepEqual(activityGroups([]), []);
});

test("resolved approval history does not mark a group as needing action", () => {
  const blocked = row("npm test", { blocked: "needs_approval" });
  assert.equal(activityGroupSummary([{ kind: "tool", row: blocked }], "complete").attention, false);
});
