import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentRequestTarget } from "../src/slack/approval-context.ts";
import type { ActorAssertion } from "../src/slack/lib.ts";

const TEAMMATE: ActorAssertion = { externalId: "dana@acme.com", displayName: "Dana" };
const REQUESTER: ActorAssertion = { externalId: "amy@acme.com", displayName: "Amy" };
const DIRECTIVE_TARGET = "U_DANA";
const emailBridge = new Map<string, string>([
  ["amy@acme.com", "U_AMY"],
  ["dana@acme.com", DIRECTIVE_TARGET],
]);

test("email mode: a Slack-id directive resolves the co-present teammate when the map is present", () => {
  const target = resolveAgentRequestTarget([REQUESTER, TEAMMATE], DIRECTIVE_TARGET, emailBridge);
  assert.equal(target, TEAMMATE);
});

test("email mode: dropping the map leaves the same teammate unresolvable (the refusal regression)", () => {
  const target = resolveAgentRequestTarget([REQUESTER, TEAMMATE], DIRECTIVE_TARGET, undefined);
  assert.equal(target, undefined);
});

test("slack-id mode: a bot/member whose externalId is already the Slack id resolves without a map", () => {
  const bot: ActorAssertion = { externalId: "B_HELPER", isBot: true, displayName: "Helper" };
  assert.equal(resolveAgentRequestTarget([REQUESTER, bot], "B_HELPER"), bot);
});

test("no audience member matches the directive target", () => {
  assert.equal(resolveAgentRequestTarget([REQUESTER, TEAMMATE], "U_STRANGER", emailBridge), undefined);
});
