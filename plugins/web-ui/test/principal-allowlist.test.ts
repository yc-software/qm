import assert from "node:assert/strict";
import test from "node:test";
import { principalInAllowlist } from "../../chassis/src/principal-allowlist.ts";

test("principal allowlists match email addresses case-insensitively and support all", () => {
  assert.equal(principalInAllowlist("Alice@Example.com", "other@example.com, alice@example.COM"), true);
  assert.equal(principalInAllowlist("alice@example.com", "all"), true);
  assert.equal(principalInAllowlist("alice@example.com", "other@example.com"), false);
  assert.equal(principalInAllowlist("", "all"), false);
});
