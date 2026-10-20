import { test } from "node:test";
import assert from "node:assert/strict";
import { eventDeliveryCheck } from "../scripts/dev/commands/doctor.ts";

test("doctor downgrades a missing canary channel to a configuration warning", () => {
  const check = eventDeliveryCheck({ ok: false, code: "unconfigured", reason: "any wording" });
  assert.equal(check.ok, false);
  assert.equal(check.severity, "warn");
  assert.match(check.remedy ?? "", /CANARY_CHANNEL/);
});

test("doctor treats every other canary failure as critical, whatever its reason text says", () => {
  const check = eventDeliveryCheck({ ok: false, reason: "no canary channel configured" });
  assert.equal(check.severity, "critical");
  assert.match(check.remedy ?? "", /dev up --rotate/);
});

test("doctor reports a successful canary round trip", () => {
  const check = eventDeliveryCheck({ ok: true, rttMs: 42 });
  assert.equal(check.ok, true);
  assert.equal(check.detail, "canary round trip 42ms");
  assert.equal(check.remedy, undefined);
});
