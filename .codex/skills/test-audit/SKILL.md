---
name: test-audit
description: Use whenever writing, changing, reviewing, or pruning QM tests. Authoring gate for new tests, an audit for low-value or duplicated tests, and a coverage-guided campaign for cutting a whole suite without losing coverage or contracts.
---

# Test Audit

Adapted from OpenClaw's `test-audit` skill (MIT; see
[LICENSE-openclaw](LICENSE-openclaw)). Three modes share one value
bar. The authoring gate checks every new or changed test. An audit removes a
few high-confidence low-value tests. A campaign prunes a whole suite; read
[CAMPAIGN.md](CAMPAIGN.md) before starting one.

QM tests run on `node:test`: root tests with
`node --experimental-test-module-mocks --test test/<file>.test.ts`, Postgres
tests through `npm run test:pg` with `DATABASE_URL`, and each plugin, the CLI,
and desktop through their own `npm test`. CI routing lives in
`.github/workflows/cicd.yml`, the `test:pg` list in `package.json`, and root
sharding in `scripts/run-root-test-shard.mjs`.

## Authoring gate

Before adding a test, answer four questions. A missing answer means do not add
it yet.

1. What observable behavior, invariant, or contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Each contract has
   one primary test at its strongest boundary, usually the HTTP route, store
   interface, or harness entry point rather than a private helper. Extend a
   table or shared fixture instead of adding a near-duplicate file.
4. Does it need a production seam (export, flag, injection hook) that no
   production caller uses? Then test at the real boundary instead.

A bug regression test must fail on the pre-fix code for the intended reason.
One regression at the owning boundary covers the bug; do not replay it at every
layer it crosses.

## Junk patterns

- assertion-free coverage probes and self-comparisons;
- copied fixtures, inventories, manifests, or export lists;
- exact source, import, or string greps of `src/`;
- private helper or call-shape tests duplicated at a real boundary;
- the same contract invoked again in a sibling file;
- tests that exist only to keep a test-only export or wrapper alive;
- expected values produced by the code under test;
- mocks that implement the asserted behavior;
- capability tests that restate a declared flag instead of exercising it;
- negative controls that pass for an unrelated reason, such as a denial from a
  different guard;
- names that promise more than the assertions check.

## Retention bar

Keep a test that independently guards security, authentication, the credential
broker, keychain and secrets, ACL and tenant isolation, migrations, Postgres
storage and the session tape, prompt bytes and system-prompt order, public HTTP
routes and the agent API, config defaults, or release and packaging. Denial
tests are usually the only proof of a guard: the happy path executing the same
lines proves nothing about the refusal. Also keep observable ordering and
regressions with a credible failure mode.

Coverage redundancy is necessary for deletion, never sufficient. A file whose
lines are all covered elsewhere may still be the only test asserting a
contract. Name the keeper test that asserts the same contract, or keep it.

A retained test that fails on the baseline is a possible product bug. Reproduce
it and report it instead of deleting it.

## Candidate evidence

Record before editing; a missing field means the candidate is not ready:

- test file and declaration;
- the failure it can actually detect;
- the keeper that asserts the same contract, or why no proof is needed;
- why the test exists (`git log -- <file>`);
- production or test-support code the deletion unlocks;
- risk and the focused validation command.

## Edit shape

One coherent owner-boundary batch per PR. Delete test-only exports, fixtures,
and helpers the deletion strands (`npm run lint:knip` finds them) and drop
removed files from the `test:pg` list and any CI step. Prefer net-negative
production LOC. Never add replacement tests that restate the implementation.

## Validation

1. Run the owner and sibling tests that remain.
2. `npm run typecheck`, `npm run lint`, `npm run lint:knip`,
   `npm run format:check`, and `npm run test:root:shard:check`.
3. Re-measure coverage with `scripts/coverage-redundancy.mjs` (see
   CAMPAIGN.md) and report the delta.
4. Report `git diff --numstat` with production and test LOC separately.
5. Get an independent adversarial review of the deletions before merge, per
   `AGENTS.md`.

## Handoff

Report the removed categories, retained false positives and why they stay,
coverage and LOC before and after, CI wall time before and after, PR state, and
follow-ups.
