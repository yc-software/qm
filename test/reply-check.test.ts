import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReplyCheck } from "../src/decisions/reply-check.ts";
import type { DecisionHooks } from "../src/decisions/hooks.ts";

const checkWith = (verdicts: ("keep" | "revise")[]) => {
  const decide = {
    mode: async () => "enforce" as const,
    run: async () => {
      const verdict = verdicts.shift() ?? "keep";
      return verdict === "revise" ? { action: "revise", message: "Drop the table." } : { action: "keep" };
    },
  } as unknown as DecisionHooks;
  return createReplyCheck({
    decide,
    input: "summarise it",
    turn: { scopeLabel: "personal:U1", sessionId: "s1", cancel: new AbortController().signal },
    posted: () => false,
    onRevise: () => {},
  });
};

const assistant = (text: string) => ({ type: "assistant" as const, payload: { text }, scopeLabel: "personal:U1" });

test("a later draft the check keeps supersedes an earlier rejected one, so no rewrite is asked for", async () => {
  const check = checkWith(["revise", "keep"]);
  assert.equal((await check.review(assistant("| a | b |"))).type, "text");
  assert.equal((await check.review(assistant("A and B."))).type, "assistant");
  assert.equal(check.takeRevision(), undefined);
});

test("a rejected draft yields one rewrite request carrying the rule's message and the draft", async () => {
  const check = checkWith(["revise"]);
  await check.review(assistant("| a | b |"));
  const prompt = check.takeRevision() ?? "";
  assert.ok(prompt.includes("Drop the table."));
  assert.ok(prompt.includes("| a | b |"));
  assert.equal(check.takeRevision(), undefined);
});
