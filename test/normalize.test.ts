import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSkill, isOrgEligibleScope, type NormalizedSkill } from "../src/skills/normalize.ts";

const ok = (r: ReturnType<typeof normalizeSkill>): NormalizedSkill => {
  assert.ok(!("skip" in r), "expected a normalized skill, got skip");
  return r as NormalizedSkill;
};

test("maps canonical fields and keeps unknowns in meta", () => {
  const r = ok(
    normalizeSkill(
      `---
name: company-directory
description: Query company directory
scope: company
version: 1.1.0
triggers:
  - "what's new"
requiredCapabilities:
  - egress:tools.internal.example.com
---
# Body here`,
      "skills/company-directory/SKILL.md",
    ),
  );
  assert.equal(r.manifest.name, "company-directory");
  assert.equal(r.manifest.description, "Query company directory");
  assert.deepEqual(r.manifest.requiredCapabilities, ["egress:tools.internal.example.com"]);
  assert.equal(r.scopeHint, "company");
  assert.equal(r.private, false);
  assert.deepEqual(r.meta.version, "1.1.0");
  assert.deepEqual(r.meta.triggers, ["what's new"]);
  assert.equal(r.meta.scope, undefined);
});

test("derives name from the dir when frontmatter omits it", () => {
  const r = ok(
    normalizeSkill(
      `---
description: no name field
---
body`,
      "skills/perplexity-research/SKILL.md",
    ),
  );
  assert.equal(r.manifest.name, "perplexity-research");
});

test("detects private from several flags and the body marker", () => {
  assert.equal(
    ok(
      normalizeSkill(
        `---
name: a
description: d
private: true
---
body`,
        "p/a/SKILL.md",
      ),
    ).private,
    true,
  );
  assert.equal(
    ok(
      normalizeSkill(
        `---
name: c
description: d
---
## Classification: THE-AGENT-ONLY`,
        "p/c/SKILL.md",
      ),
    ).private,
    true,
  );
});

test("derives requiredCapabilities from an egress alias and creds from $ENV refs", () => {
  const r = ok(
    normalizeSkill(
      `---
name: x
description: d
egress: api.exa.ai
---
Run with $EXA_API_KEY set.`,
      "skills/x/SKILL.md",
    ),
  );
  assert.deepEqual(r.manifest.requiredCapabilities, ["egress:api.exa.ai"]);
  assert.ok(r.declaredCreds.includes("EXA_API_KEY"));
});

test("fieldOverrides remaps an odd key onto a canonical one", () => {
  const r = ok(
    normalizeSkill(
      `---
title: My Skill
summary: does things
---
body`,
      "skills/my/SKILL.md",
      { fieldOverrides: { title: "name", summary: "description" } },
    ),
  );
  assert.equal(r.manifest.name, "My Skill");
  assert.equal(r.manifest.description, "does things");
});

test("malformed (no frontmatter fence / empty body) → skip", () => {
  assert.deepEqual(normalizeSkill("no frontmatter", "p/a/SKILL.md"), { skip: true, reason: "malformed" });
  assert.deepEqual(
    normalizeSkill(
      `---
name: a
description: d
---
`,
      "p/a/SKILL.md",
    ),
    { skip: true, reason: "malformed" },
  );
});

test("a missing description is derived from the body, not dropped", () => {
  const r = ok(
    normalizeSkill(
      `---
name: a
---
# A title

Does the thing.`,
      "p/a/SKILL.md",
    ),
  );
  assert.equal(r.manifest.description, "Does the thing.", "derived from the first prose line of the body");
  const h = ok(
    normalizeSkill(
      `---
name: b
---
# Only a heading`,
      "p/b/SKILL.md",
    ),
  );
  assert.equal(h.manifest.description, "Only a heading");
});

test("isOrgEligibleScope: eligible unless explicitly personal; missing scope is eligible", () => {
  assert.equal(isOrgEligibleScope("company"), true);
  assert.equal(isOrgEligibleScope("both"), true);
  assert.equal(isOrgEligibleScope("org"), true);
  assert.equal(isOrgEligibleScope(undefined), true);
  assert.equal(isOrgEligibleScope("team"), true);
  assert.equal(isOrgEligibleScope("personal"), false);
  assert.equal(isOrgEligibleScope("person"), false);
  assert.equal(isOrgEligibleScope("private"), false);
});
