import { test } from "node:test";
import assert from "node:assert/strict";
import { eventDeliveryCheck } from "../scripts/dev/commands/doctor.ts";

test("doctor warns on a missing canary channel by code and treats every other canary failure as critical", () => {
  assert.equal(eventDeliveryCheck({ ok: false, code: "unconfigured", reason: "any wording" }).severity, "warn");
  assert.equal(eventDeliveryCheck({ ok: false, reason: "no canary channel configured" }).severity, "critical");
});
