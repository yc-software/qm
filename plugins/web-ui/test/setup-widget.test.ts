import { test } from "node:test";
import assert from "node:assert/strict";
import { setupContent } from "../src/setup-widget.ts";

test("renders a standalone setup directive in order with surrounding reply text", () => {
  const parts = setupContent("Choose an app below.\n\n::connect-apps{}\n\nI'll help once it is connected.");
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "setup", "text"],
  );
  assert.match(parts[0].type === "text" ? parts[0].text : "", /Choose an app/);
});

test("examples, quoted directives, inline text, and incomplete streaming syntax stay text", () => {
  for (const text of [
    "```text\n::connect-apps{}\n```",
    "> ::connect-apps{}",
    "Use ::connect-apps{} here",
    "`::connect-apps{}`",
    "::connect-apps{",
    "    ::connect-apps{}",
  ])
    assert.equal(
      setupContent(text).some((part) => part.type === "setup"),
      false,
      text,
    );
});

test("Slack and apps render independently", () => {
  assert.deepEqual(
    setupContent("::add-to-slack{}\n\n::connect-apps{}").filter((part) => part.type !== "text"),
    [{ type: "slack" }, { type: "setup" }],
  );
});

test("personal Slack linking has its own standalone widget trigger", () => {
  assert.deepEqual(setupContent("::link-slack-account{}"), [{ type: "slack-account" }]);
  for (const text of [
    "`::link-slack-account{}`",
    "> ::link-slack-account{}",
    "Use ::link-slack-account{} here",
    "```text\n::link-slack-account{}\n```",
    "::link-slack-account{",
  ])
    assert.equal(
      setupContent(text).some((part) => part.type === "slack-account"),
      false,
    );
});

test("an app-scoped picker directive carries its catalog id", () => {
  assert.deepEqual(setupContent('Notion is not connected yet.\n\n::connect-apps{toolkit="notion"}').slice(1), [
    { type: "setup", toolkit: "notion" },
  ]);
  assert.deepEqual(setupContent("::connect-apps{toolkit=googlecalendar}"), [
    { type: "setup", toolkit: "googlecalendar" },
  ]);
  assert.deepEqual(setupContent("toString"), [{ type: "text", text: "toString" }]);
  for (const text of [
    '`::connect-apps{toolkit="notion"}`',
    '> ::connect-apps{toolkit="notion"}',
    'Use ::connect-apps{toolkit="notion"} here',
    '::connect-apps{toolkit="Notion App"}',
    '::connect-apps{toolkit="notion}',
  ])
    assert.equal(
      setupContent(text).some((part) => part.type === "setup"),
      false,
      text,
    );
});
