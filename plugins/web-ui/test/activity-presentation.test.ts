import { item } from "./item-fixture.ts";
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
import type { ToolRowModel, TimelineItem } from "../src/timeline.ts";

type Fields = NonNullable<Parameters<typeof item>[1]>;

const callItem = (tool: string, body: Record<string, unknown>) =>
  item("ToolCall", { seq: 1, createdAt: 1, tool, body });
const resultItem = (fields: Fields) => item("ToolResult", { seq: 2, createdAt: 2, ...fields });

function row(command: string, result: Fields | null = { body: { code: 0 } }): ToolRowModel {
  return {
    call: callItem("sandbox", { action: "exec", command }),
    result: result ? resultItem(result) : null,
  };
}

const call = (tool: string, body: Record<string, unknown>): ToolRowModel => ({
  call: callItem(tool, body),
  result: null,
});

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
    assert.equal(activityDescription(call("execute", { command })).category, "execute");
  }
  assert.equal(
    activityLabel(row("rg -n 'gateway|secret' src/main.ts"), "complete"),
    "Searched for gateway|secret in main.ts",
  );
  assert.equal(activityLabel(row("sed -n '1,120p' src/main.ts"), "complete"), "main.ts");
  assert.equal(activityLabel(row("rg --files src"), "complete"), "Searched for files in src");
  assert.deepEqual(activityDescription(call("skill", { name: "publish" })), {
    category: "read",
    target: "publish",
  });
  assert.deepEqual(activityDescription(call("skills", { action: "read", name: "admin", path: "SKILL.md" })), {
    category: "read",
    target: "admin",
  });
  assert.deepEqual(activityDescription(call("skill", { name: "publish", path: "templates/x.md" })), {
    category: "read",
    target: "publish/x.md",
  });
});

test("status labels never report missing or failed results as successful", () => {
  assert.equal(activityLabel(row("npm test", null), "working"), "Running npm test");
  assert.equal(activityLabel(row("npm test", null), "complete"), "Tried running npm test");
  assert.equal(activityLabel(row("cat missing", { body: { code: 1 } }), "complete"), "missing · exit 1");
  assert.equal(activityLabel(row("npm test", { body: { blocked: "needs_approval" } }), "working"), null);
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
  items.push({ kind: "tool", row: row("false", { body: { code: 1 } }) });
  assert.equal(activityGroupSummary(items, "complete").attention, false);
  assert.doesNotMatch(activityGroupSummary(items, "complete").label, /failed/);
  items.push({ kind: "tool", row: row("sleep 60", { isError: true, body: { code: 124, timedOut: true } }) });
  assert.equal(activityGroupSummary(items, "complete").attention, true);
  assert.match(activityGroupSummary(items, "complete").label, /1 failed/);
  items.push({ kind: "tool", row: row("run", { body: { blocked: "needs_approval" } }) });
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
    title: "Thinking",
    body: "A thought without a heading",
  });
  assert.equal(thinkingPresentation("**Bold** inside a sentence").title, "Thinking");
});

test("session actions identify their recipient and retain failure state", () => {
  const tool = row("");
  tool.call = callItem("session", {
    action: "send_message",
    target: "compaction-exact",
    text: "Check the remaining tests",
  });
  assert.deepEqual(sessionPresentation(tool, "complete"), {
    label: "Sent message to",
    target: "compaction-exact",
    preview: "Check the remaining tests",
  });
  tool.result = resultItem({ isError: true });
  assert.equal(sessionPresentation(tool, "complete")?.label, "Failed to send message to");
  tool.call = callItem("session", { action: "open", name: "worker" });
  tool.result = resultItem({ body: { title: "Named worker", sessionId: "id" } });
  assert.equal(sessionPresentation(tool, "complete")?.target, "Named worker");
  tool.call = callItem("sessions", { action: "open", name: "worker" });
  assert.equal(sessionPresentation(tool, "complete")?.target, "Named worker");
  tool.call = callItem("subagents", { action: "open", name: "worker" });
  assert.equal(sessionPresentation(tool, "complete")?.target, "Named worker");
  tool.call = callItem("sessions", { action: "list" });
  tool.result = resultItem({});
  assert.equal(sessionPresentation(tool, "complete")?.target, "sessions");
});

test("activity grouping preserves speech boundaries and chronological item identity", () => {
  const tool: TimelineItem = { kind: "tool", row: row("npm test") };
  const speech: TimelineItem = {
    kind: "text",
    item: item("AgentMessage", { seq: 8, createdAt: 2, variant: "narration", text: "Checking" }),
  };
  const thought: TimelineItem = { kind: "thinking", seq: 9, step: null, text: "**Check**\nDetails" };
  assert.deepEqual(activityGroups([tool, speech, thought, tool]), [[tool], [speech], [thought, tool]]);
  assert.deepEqual(activityGroups([]), []);
});

test("resolved approval history does not mark a group as needing action", () => {
  const blocked = row("npm test", { body: { blocked: "needs_approval" } });
  assert.equal(activityGroupSummary([{ kind: "tool", row: blocked }], "complete").attention, false);
});

test("purpose takes precedence over commands while retaining failure and incomplete states", () => {
  const tool = row("cat /workspace/report.csv");
  tool.call = { ...tool.call!, body: { ...tool.call!.body, purpose: "  Check the sales totals  " } };
  assert.equal(activityLabel(tool, "complete"), "Check the sales totals");
  tool.result = null;
  assert.equal(activityLabel(tool, "working"), "Check the sales totals");
  assert.equal(activityLabel(tool, "complete"), "Check the sales totals · Unconfirmed");
  tool.result = resultItem({ body: { code: 1 } });
  assert.equal(activityLabel(tool, "complete"), "Check the sales totals · exit 1");
  tool.result = resultItem({ isError: true, body: { code: 124, timedOut: true } });
  assert.equal(activityLabel(tool, "complete"), "Check the sales totals · Failed");
  tool.result = resultItem({ body: { blocked: "needs_approval" } });
  assert.equal(activityLabel(tool, "working"), null);
  tool.call = callItem("sandbox", { action: "start_process", purpose: "Start the preview server" });
  tool.result = null;
  assert.equal(activityLabel(tool, "working"), "Start the preview server");
  tool.call = callItem("execute", { command: "cat report.csv", purpose: "  " });
  assert.equal(activityLabel(tool, "working"), "Reading report.csv");
});

test("ordinary command exits stay neutral while tool errors retain failure labels", () => {
  for (const [toolName, identity] of [
    ["execute", {}],
    ["sandbox", { action: "exec" }],
  ] as const) {
    for (const [command, label] of [
      ["grep absent file", "Searched for absent in file"],
      ["[ -d dir ]", "[ -d dir ]"],
    ]) {
      const tool = row(command!, { isError: false, body: { code: 1 } });
      tool.call = callItem(toolName, { ...identity, command });
      assert.equal(activityLabel(tool, "complete"), `${label} · exit 1`);
      for (const result of [
        { isError: true, body: { code: 1 } },
        { body: { code: 124, timedOut: true } },
        { body: { error: "provider unavailable" } },
        { body: { denied: true } },
      ]) {
        tool.result = resultItem(result);
        assert.match(activityLabel(tool, "complete")!, /Failed/);
        assert.doesNotMatch(activityLabel(tool, "complete")!, /exit/);
      }
    }
  }
});

test("historical completed nonzero exits do not inherit the old error flag", () => {
  for (const [toolName, identity] of [
    ["execute", {}],
    ["sandbox", { action: "exec" }],
  ] as const) {
    for (const output of [
      { text: "[exit 1]", body: {} },
      { text: "[NOT security-screened]\n[exit 1]", body: { unscreened: true } },
    ]) {
      const tool = row("[ -d dir ]", {
        tool: toolName,
        text: output.text,
        isError: true,
        body: { ...identity, ...output.body, code: 1, timedOut: false },
      });
      tool.call = callItem(toolName, { ...identity, command: "[ -d dir ]", purpose: "Check directory" });
      assert.equal(activityLabel(tool, "complete"), "Check directory · exit 1");
      assert.deepEqual(activityGroupSummary([{ kind: "tool", row: tool }], "complete"), {
        label: "Ran commands",
        category: "execute",
        attention: false,
      });
      for (const failure of [
        { timedOut: true },
        { error: "provider error" },
        { denied: true },
        { quarantined: true },
      ]) {
        const failed = { ...tool, result: { ...tool.result!, body: { ...tool.result!.body, ...failure } } };
        assert.equal(activityLabel(failed, "complete"), "Check directory · Failed");
      }
    }
  }
});
