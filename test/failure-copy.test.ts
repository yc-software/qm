import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_BUSY_FIRE_TEXT,
  SESSION_BUSY_USER_TEXT,
  standaloneFailureText,
  userFacingFailureClause,
  userFacingFailureText,
} from "../src/core/failure-copy.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../plugins/chassis/src/security-quarantine.ts";
import { GENERIC_FAILURE_TEXT } from "../plugins/chassis/src/failure-copy.ts";

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

  const busy = { status: "refused", refusalKind: "session_busy", reason: SESSION_BUSY_USER_TEXT } as const;
  assert.equal(userFacingFailureText(busy), SESSION_BUSY_USER_TEXT);
  assert.equal(standaloneFailureText(busy), SESSION_BUSY_USER_TEXT);
  assert.equal(userFacingFailureClause(busy), "the conversation was busy with another task");

  const busyFire = { status: "refused", refusalKind: "session_busy", reason: SESSION_BUSY_FIRE_TEXT } as const;
  assert.equal(userFacingFailureText(busyFire), SESSION_BUSY_FIRE_TEXT);
  assert.doesNotMatch(userFacingFailureText(busyFire), /send that again/i);

  const authored = { status: "refused", reason: "you're not a member of that context" };
  assert.equal(userFacingFailureText(authored), "you're not a member of that context");
  assert.equal(userFacingFailureClause(authored), "you're not a member of that context");
  assert.equal(standaloneFailureText(authored), undefined);

  const failed = { status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42" };
  assert.equal(userFacingFailureText(failed), GENERIC_FAILURE_TEXT);
  assert.equal(userFacingFailureClause(failed), "something went wrong on my end");
  assert.doesNotMatch(userFacingFailureText(failed), /TypeError|sandbox\.ts/);

  assert.equal(userFacingFailureText({ status: "refused" }), GENERIC_FAILURE_TEXT);
});

test("a failed run's recorded person-facing reason is shown instead of the generic text", () => {
  assert.equal(
    userFacingFailureText({
      status: "failed",
      failureMessage: "The prompt is too long for this model's context window.",
    }),
    "The prompt is too long for this model's context window.",
  );
  assert.equal(userFacingFailureText({ status: "failed", reason: "lease expired (reaped)" }), GENERIC_FAILURE_TEXT);
  assert.equal(userFacingFailureText({ status: "failed", failureMessage: "  " }), GENERIC_FAILURE_TEXT);
});
