import assert from "node:assert/strict";
import test from "node:test";
import { sessionToolView } from "../src/timeline.ts";

const sessions = [{ id: "child-123", title: "bug 1" }];

test("created badges recover a known child from historical result text", () => {
  const view = sessionToolView(
    { action: "open", name: "Original name" },
    { unscreened: true, result: 'Opened subagent "Original name" (sessionId child-123). It is working now.' },
    sessions,
  );
  assert.equal(view.sessionId, "child-123");
  assert.equal(view.chipTitle, "bug 1");
});

test("checked badges resolve target IDs to current session names", () => {
  const view = sessionToolView({ action: "read", target: "child-123" }, {}, sessions);
  assert.equal(view.sessionId, "child-123");
  assert.equal(view.chipTitle, "bug 1");
});

test("unknown targets stay unlinked and do not display raw IDs", () => {
  const view = sessionToolView({ action: "read", target: "unknown-id" }, {}, sessions);
  assert.equal(view.sessionId, undefined);
  assert.equal(view.chipTitle, "Subagent");
});

test("reading the child list renders a count without a target badge", () => {
  assert.deepEqual(sessionToolView({ action: "read" }, { children: 3 }, sessions), {
    action: "read",
    detail: "3 subagents",
  });
});

test("historical list reads stay a plural label without a fake child badge", () => {
  assert.deepEqual(sessionToolView({ action: "read" }, { unscreened: true }, sessions), {
    action: "read",
    detail: "subagents",
  });
});

test("wait has no phantom subagent badge", () => {
  assert.deepEqual(sessionToolView({ action: "wait" }, {}, sessions), { action: "wait", detail: "for agent messages" });
});

test("sibling messaging resolves title targets into clickable badges", () => {
  const view = sessionToolView(
    { action: "send_message", target: sessions[0]!.title },
    { delivered: "queued_message" },
    sessions,
  );
  assert.equal(view.sessionId, sessions[0]!.id);
  assert.equal(view.chipTitle, sessions[0]!.title);
  assert.equal(view.detail, "");
});
