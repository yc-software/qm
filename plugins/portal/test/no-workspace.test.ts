import test from "node:test";
import assert from "node:assert/strict";
import { noWorkspaceLinksFor, parseNoWorkspaceLinks } from "../src/no-workspace.ts";

test("no-workspace links map a configured claim's values to https addresses, at most three, in claim order", () => {
  const { config, problem } = parseNoWorkspaceLinks(
    JSON.stringify({
      claim: "org",
      links: {
        acme: "https://acme.example.com/",
        "42": "https://forty-two.example.com/",
        beta: "https://beta.example.com/",
        gamma: "https://gamma.example.com/",
        delta: "https://delta.example.com/",
      },
    }),
  );
  assert.equal(problem, undefined);
  assert.deepEqual(noWorkspaceLinksFor(config, { org: "acme" }), ["https://acme.example.com/"]);
  assert.deepEqual(noWorkspaceLinksFor(config, { org: [42, "unknown", "acme"] }), [
    "https://forty-two.example.com/",
    "https://acme.example.com/",
  ]);
  assert.equal(noWorkspaceLinksFor(config, { org: ["beta", "gamma", "delta", "acme"] }).length, 3);
  assert.deepEqual(noWorkspaceLinksFor(config, { other: "acme" }), []);
  assert.deepEqual(noWorkspaceLinksFor(null, { org: "acme" }), []);
});

test("a malformed no-workspace links setting is reported and offers nothing", () => {
  assert.deepEqual(parseNoWorkspaceLinks(undefined), { config: null });
  for (const raw of [
    "{",
    JSON.stringify({ links: {} }),
    JSON.stringify({ claim: "org", links: { acme: "http://acme.example.com" } }),
    JSON.stringify({ claim: "org", links: { acme: "javascript:alert(1)" } }),
    JSON.stringify({ claim: "org", links: { acme: "https://user:pw@acme.example.com" } }),
  ]) {
    const parsed = parseNoWorkspaceLinks(raw);
    assert.equal(parsed.config, null, raw);
    assert.match(parsed.problem ?? "", /PORTAL_NO_WORKSPACE_LINKS/);
  }
});
