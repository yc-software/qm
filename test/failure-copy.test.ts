import { test } from "node:test";
import assert from "node:assert/strict";
import { standaloneFailureText, userFacingFailureClause } from "../src/core/failure-copy.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../plugins/chassis/src/security-quarantine.ts";
import { GENERIC_FAILURE_TEXT, userFacingFailureText } from "../plugins/chassis/src/failure-copy.ts";

test("the shared failure policy renders quarantine canned, refused reasons verbatim, everything else generic", () => {
  const quarantine = {
    status: "refused",
    refusalKind: "security_quarantine",
    reason: "internal screening details",
  } as const;
  assert.equal(userFacingFailureText(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.doesNotMatch(userFacingFailureText(quarantine), /internal screening details/);
  assert.equal(userFacingFailureClause(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.equal(standaloneFailureText(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);

  const budget = { status: "refused", refusalKind: "model_budget", reason: "the model budget is spent" } as const;
  assert.equal(userFacingFailureText(budget), "the model budget is spent");
  assert.equal(standaloneFailureText(budget), "the model budget is spent");
  assert.equal(userFacingFailureClause(budget), "the model budget is spent");

  const authored = { status: "refused", reason: "you're not a member of that context" };
  assert.equal(userFacingFailureText(authored), "you're not a member of that context");
  assert.equal(userFacingFailureClause(authored), "you're not a member of that context");
  assert.equal(standaloneFailureText(authored), undefined);

  const failed = { status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42" };
  assert.equal(userFacingFailureText(failed), GENERIC_FAILURE_TEXT);
  assert.equal(userFacingFailureClause(failed), "something went wrong on my end");
  assert.doesNotMatch(userFacingFailureText(failed), /TypeError|sandbox\.ts/);

  const blocked = { status: "failed", errorCode: "refusal", reason: "Provider finish_reason: content_filter" };
  assert.equal(
    userFacingFailureClause(blocked),
    "the model provider blocked the reply (Provider finish_reason: content_filter)",
  );
  assert.equal(
    userFacingFailureText(blocked),
    "I couldn't finish that: the model provider blocked the reply (Provider finish_reason: content_filter).",
  );

  assert.equal(userFacingFailureText({ status: "refused" }), GENERIC_FAILURE_TEXT);
});
