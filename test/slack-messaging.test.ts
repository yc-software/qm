import assert from "node:assert/strict";
import { test } from "node:test";
import { createStreamingReplyFilter } from "../src/slack/messaging.ts";

test("streaming reply filter emits prose incrementally and never exposes internal directives", () => {
  const filter = createStreamingReplyFilter();
  const visible = [
    filter.push("Here is the answer. "),
    filter.push("[[rea"),
    filter.push("ct: eyes]]"),
    filter.push(" Done."),
    filter.flush(),
  ].join("");

  assert.equal(visible, "Here is the answer.  Done.");
  assert.equal(visible.includes("[[react"), false);
});

test("streaming reply filter holds a split agent request directive out of Slack", () => {
  const filter = createStreamingReplyFilter();
  const visible = [
    filter.push("I need help. [[ask-"),
    filter.push("agent: <@U2> | inspect token=secret"),
    filter.push("]] Thanks."),
    filter.flush(),
  ].join("");

  assert.equal(visible, "I need help.  Thanks.");
  assert.equal(visible.includes("token=secret"), false);
});
