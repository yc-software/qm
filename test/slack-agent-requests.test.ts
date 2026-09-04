import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRequestMessage, extractAgentRequests, stripAgentRequestDirectives } from "../src/slack/lib.ts";

test("agentRequestMessage builds a personal-agent approval prompt", () => {
  const msg = agentRequestMessage({
    requestId: "agent-req-1",
    originAgentLabel: "#project-alpha agent",
    targetAgentLabel: "Carol's personal agent",
    task: "Check whether browse-agent works with the personal ANTHROPIC_API_KEY, but do not reveal the key.",
  });
  assert.match(msg.text, /asking Carol's personal agent/);
  const section = msg.blocks.find((b) => b.type === "section") as any;
  assert.match(section.text.text, /#project-alpha agent → Carol's personal agent/);
  const actions = msg.blocks.find((b) => b.type === "actions") as any;
  assert.deepEqual(
    actions.elements.map((e: any) => [e.text.text, e.action_id, e.value]),
    [
      ["Run with my setup", "agent_request_run", "agent-req-1"],
      ["Decline", "agent_request_deny", "agent-req-1"],
    ],
  );
});

test("extractAgentRequests pulls an ask-agent directive out and strips it from the reply", () => {
  const r = extractAgentRequests(
    "I need Carol's personal setup for that.\n\n[[ask-agent: <@U2> | Check whether browse-agent can use your ANTHROPIC_API_KEY without revealing it.]]",
  );
  assert.deepEqual(r.requests, [
    {
      targetUserId: "U2",
      task: "Check whether browse-agent can use your ANTHROPIC_API_KEY without revealing it.",
    },
  ]);
  assert.equal(r.text, "I need Carol's personal setup for that.");
});

test("extractAgentRequests handles raw user ids, streamed partial stripping, and code examples", () => {
  assert.deepEqual(extractAgentRequests("[[ask-agent: U2 | run a quick check]]").requests, [
    { targetUserId: "U2", task: "run a quick check" },
  ]);
  assert.equal(stripAgentRequestDirectives("asking [[ask-agent: <@U2> | run it]] now"), "asking  now");
  assert.equal(stripAgentRequestDirectives("asking [[ask-agent: <@U2> | run"), "asking ");

  const inline = extractAgentRequests("Use `[[ask-agent: <@U2> | task]]` to ask a personal agent.");
  assert.deepEqual(inline.requests, []);
  assert.equal(inline.text, "Use `[[ask-agent: <@U2> | task]]` to ask a personal agent.");
});
