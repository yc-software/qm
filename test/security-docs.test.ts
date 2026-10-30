import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const security = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");

test("the public threat model covers the documented material limitations", () => {
  for (const heading of [
    "## Threat model and limitations",
    "### Scope",
    "### Protected assets and actors",
    "### Trust boundaries and operator assumptions",
    "### What the controls do and do not guarantee",
    "### Known limitations",
  ]) {
    assert.ok(security.includes(heading), `SECURITY.md includes ${heading}`);
  }
  for (const limitation of [
    "Command policy is bypassable",
    "Browser actions sit outside some core gates",
    "Sandbox credentials are plaintext while in use",
    "Credential purposes are not enforced authorization",
    "Security screening is incomplete and heuristic",
    "Audience-floor filtering has known gaps",
    "Egress enforcement is conditional",
    "Admins can read sensitive content",
    "Durable data can outlive user expectations",
    "Published-app capability links are bearer authorization",
    "Portal sessions have residual risk",
    "Some model-provider paths bypass the intended gateway",
  ]) {
    assert.ok(security.includes(limitation), `SECURITY.md includes ${limitation}`);
  }
  assert.match(security, /visitors outside\s+the organization/);
  assert.doesNotMatch(security, /signature is not verified/);
  assert.match(security, /eight\s+hours and renews on use/);
  assert.match(security, /not exhaustive/);
});
