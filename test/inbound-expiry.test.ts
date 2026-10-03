import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInboundExpiresAt } from "../src/api/expiry.ts";

test("expiresAt accepts epoch seconds and milliseconds sent as digit strings", () => {
  assert.deepEqual(normalizeInboundExpiresAt("1790000000"), { ok: true, value: 1_790_000_000_000 });
  assert.deepEqual(normalizeInboundExpiresAt(" 1790000000000 "), { ok: true, value: 1_790_000_000_000 });
  assert.deepEqual(normalizeInboundExpiresAt(1_790_000_000), { ok: true, value: 1_790_000_000_000 });
  assert.deepEqual(normalizeInboundExpiresAt("2026-09-21T12:00:00Z"), {
    ok: true,
    value: Date.UTC(2026, 8, 21, 12),
  });
  assert.equal(normalizeInboundExpiresAt("").ok, false);
  assert.equal(normalizeInboundExpiresAt("12").ok, false);
});
