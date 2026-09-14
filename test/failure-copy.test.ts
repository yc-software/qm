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
  assert.doesNotMatch(userFacingFailureText(quarantine), /ask an admin/i);
  assert.equal(userFacingFailureClause(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);
  assert.equal(standaloneFailureText(quarantine), SECURITY_QUARANTINE_REFUSAL_TEXT);

  const linkedQuarantine = { ...quarantine, adminUrl: "https://portal.example.com/admin/history/s/s-1" };
  assert.equal(
    userFacingFailureText(linkedQuarantine),
    "I couldn't act because my security screen flagged part of this message or its conversation context. Please retry without the flagged context, or ask an admin to review this quarantine in session history: https://portal.example.com/admin/history/s/s-1",
  );
  assert.doesNotMatch(userFacingFailureText(linkedQuarantine), /internal screening details/);
  assert.equal(userFacingFailureText(linkedQuarantine).match(/https:\/\//g)?.length, 1);
  assert.match(
    userFacingFailureText({
      ...quarantine,
      adminUrl: "HTTPS://PORTAL.EXAMPLE.COM/admin/history/s/s-1",
    }),
    /https:\/\/portal\.example\.com\/admin\/history\/s\/s-1$/,
  );
  for (const adminUrl of [
    "javascript:alert(1)",
    "ftp://portal.example.com/admin/history/s/s-1",
    "not a URL",
    "http:portal.example.com/admin/history/s/s-1",
    "\nhttps://portal.example.com/admin/history/s/s-1",
    "https://portal.example.com/admin/history/s/s-1\nspoofed",
    "https://portal.example.com/admin/history/s/<s-1>",
    'https://portal.example.com/admin/history/s/"s-1"',
    "https://portal.example.com/admin/history/s/'s-1'",
  ]) {
    const text = userFacingFailureText({ ...quarantine, adminUrl });
    assert.equal(text, SECURITY_QUARANTINE_REFUSAL_TEXT);
    assert.doesNotMatch(text, /admin|review|internal screening details/i);
  }

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
