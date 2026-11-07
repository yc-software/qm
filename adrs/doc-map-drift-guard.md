# Generalize secret-schema-drift into a doc-map drift guard

`test/secret-schema-drift.test.ts` already encodes a pattern worth pulling out as a
general convention: two sources of truth (CLI secret specs and runtime secret specs)
are checked to stay in agreement instead of trusting someone to update both by hand.
That's the right instinct — and at 89+ PRs in the first 3 days, qm's docs (README,
deployment.md, SECURITY.md, docs/getting-started.md, docs/deploy-directory.md,
cli/README.md, deploy/layers/README.md) are going to drift from the code they
describe faster than anyone updating them by hand can keep up with. #7, #8, #9, and
#13 are already docs-vs-reality fixes from the first three days.

The convention we use for this across our own repos is a tiny `doc-map.yaml` per
protected doc: `doc -> [source files it describes]`. A CI check or session-start hook
reads it and warns (doesn't block) whenever a source file listed under a doc changes
without the doc changing in the same PR — cheap, git-diff-only, no LLM call needed
for the check itself. It's the same idea as secret-schema-drift.test.ts, generalized
from one pair of files to any doc/source relationship, scoped to a whitelist so it
never nags about undocumented internals.

This is running in production for us already; happy to describe the exact schema,
hook trigger, and whitelist rules in more detail if it's a direction you'd want.
