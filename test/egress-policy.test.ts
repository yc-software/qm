import { test } from "node:test";
import assert from "node:assert/strict";
import { hostMatches, isHostDenied, egressDecision } from "../src/resolution/egress-policy.ts";
import type { EgressPolicy } from "../src/types.ts";

test("hostMatches: exact + subdomain, not siblings or superstrings", () => {
  assert.equal(hostMatches("example.com", "example.com"), true);
  assert.equal(hostMatches("API.Example.com", "example.com"), true);
  assert.equal(hostMatches("a.b.example.com", "example.com"), true);
  assert.equal(hostMatches("notexample.com", "example.com"), false);
  assert.equal(hostMatches("example.com.evil.com", "example.com"), false);
});

test("hostMatches: tolerates *. / trailing dot, and a trailing-dot request host can't evade", () => {
  assert.equal(hostMatches("api.example.com", "*.example.com"), true);
  assert.equal(hostMatches("example.com", "example.com."), true);
  assert.equal(hostMatches("api.example.com.", "example.com"), true);
});

test("hostMatches: IDN folds to punycode (Unicode rule matches the punycode request host)", () => {
  const reqHost = new URL("https://pästebin.com").hostname;
  assert.notEqual(reqHost, "pästebin.com");
  assert.equal(hostMatches(reqHost, "pästebin.com"), true);
});

test("hostMatches: host-only — a rule's port / path / userinfo reduce to the bare host", () => {
  assert.equal(hostMatches("api.example.com", "example.com:443"), true);
  assert.equal(hostMatches("api.example.com", "example.com/v1"), true);
  assert.equal(hostMatches("api.example.com", "user@example.com"), true);
});

test("hostMatches: IPv6 literals compare equal across bracketed / bare / uncompressed forms", () => {
  assert.equal(hostMatches("[::1]", "::1"), true);
  assert.equal(hostMatches("::1", "[::1]"), true);
  assert.equal(hostMatches("[2001:db8::1]", "2001:0db8::1"), true);
  assert.equal(hostMatches("::1", "::2"), false);
});

test("hostMatches / isHostDenied: empty operands and empty denylist never match", () => {
  assert.equal(hostMatches("", "example.com"), false);
  assert.equal(hostMatches("example.com", ""), false);
  assert.equal(isHostDenied("example.com", undefined), false);
  assert.equal(isHostDenied("example.com", []), false);
  assert.equal(isHostDenied("api.example.com", ["example.com"]), true);
});

test("egressDecision: no policy ⇒ allow", () => {
  assert.deepEqual(egressDecision("anything.test", undefined), { allow: true, verdict: "ok" });
});

test("egressDecision: a deny wins, including over an allowlisted host", () => {
  const policy: EgressPolicy = { allowedHosts: ["example.com"], deniedHosts: ["api.example.com"] };
  assert.deepEqual(egressDecision("api.example.com", policy), { allow: false, verdict: "denied" });
  assert.deepEqual(egressDecision("www.example.com", policy), { allow: true, verdict: "ok" });
});

test("egressDecision: empty allowlist = pure denylist mode (allow anything not denied)", () => {
  const policy: EgressPolicy = { allowedHosts: [], deniedHosts: ["bad.test"] };
  assert.equal(egressDecision("anything.test", policy).allow, true);
  assert.deepEqual(egressDecision("x.bad.test", policy), { allow: false, verdict: "denied" });
});

test("egressDecision: a non-empty allowlist requires a match", () => {
  const policy: EgressPolicy = { allowedHosts: ["api.internal"], deniedHosts: [] };
  assert.equal(egressDecision("api.internal", policy).allow, true);
  assert.deepEqual(egressDecision("example.com", policy), { allow: false, verdict: "not_allowlisted" });
});
