---
name: add-tests
description: >
  Write tests for code changes made in the current session. TRIGGER when the user asks to
  "add tests" or "write tests" for those changes. Analyzes branch changes and session history
  to write smart, deterministic tests that validate the intent (features, bug fixes, perf
  improvements, etc.).
---

# Test Writer: Intent-Driven Test Generation

Write tests that validate the *intent* behind code changes — not just line coverage, but whether the feature works, the bug is fixed, or the performance goal is met.

## Three Absolute Rules

**1. NO FLAKY TESTS.** Every test must be fully deterministic. A flaky test that
randomly fails in CI is worse than no test at all. The most common source is
**timing** — async races, unfrozen clocks, fake timers fired without
`userEvent.setup({ advanceTimers })`, fire-and-forget side effects checked before
they complete. If you cannot make a test deterministic, don't write it.

Freezing the clock is the fix for the first half of that, and a trap in its own
right. Anchor a frozen clock to `Time.current` / `Date.current` and offset from
it — a literal like `travel_to(Time.utc(2026, 7, 27))` is a fixed point the real
clock keeps moving away from, so any duration the test derives from it (a TTL, a
retention window, an `expires_at`) eventually lands in the past and the test
fails on every run from then on. And freeze the whole example or none of it: a
write inside `travel_to` with an assertion outside it puts the two on different
clocks. See "Pinned clocks" in the `detect-flaky-tests` skill.

**2. NO MEANINGLESS TESTS.** Every test must assert real behavior in a way that
would catch a genuine regression. Ask: "If someone broke this, would this test
catch it? Would a thoughtful engineer have written it?" "Renders without
crashing", "returns a value", "click X and text Y appears", and "the mocked child
rendered" all fail that test — don't write them.

**3. FEWER, BETTER TESTS.** Coverage is not the goal; signal is. One test that
varies real data and boundary conditions beats ten near-identical permutation
tests. Don't write a test per branch or a reflexive boundary test per happy path —
test the cases where wrong behavior is an actual bug, and skip the rest. For
frontend especially: prefer extracting logic and unit-testing it over rendering
UI; mock only at the external boundary, never your own children.

## Discouraged Test Patterns

These are the categories the Aug 2026 prune removed ~5,000
of. Do not write them, and you may delete them when touching a file (see
"Don't drop existing tests silently" in phase 3):

- **Existence-only**: sole assertion is `toBeInTheDocument` / `toBeVisible` /
  `toBeDefined` / static text or label present / "renders without crashing".
- **Constant restatement**: `expect(SomeClass::CONST).to eq(<its literal>)`,
  asserting a lookup table, default object, or Zod/JSON schema equals its own
  definition.
- **Framework/schema guarantees**: new shoulda validation or association
  one-liners, enum predicates, DB index existence, controlled-input
  echoes.
- **Mock choreography**: asserting a mocked child rendered, mock-returns-X
  assert-X, stub-the-service-assert-the-stub delegation
  (`have_received(:call)` on an internal collaborator with nothing else).
- **Styling**: CSS classes, Tailwind tokens, pixel widths, markup snapshots.

Exception: none of this licenses removing tests that guard auth/authz, money,
sends, or a past regression — those stay even when they look trivial.

## Adversarial Boundary Coverage

Reason about what BREAKS the change, not just that the happy path works —
clean-data testing validates intent, not boundaries:

- **External-boundary fields** (request params, API/JSON payloads, nullable DB
  columns): guard and null/empty-test them UNIFORMLY — if one sibling field gets
  a nil/`?? ""` guard, ALL of them do, each with its own null test. Don't fix
  one and leave its siblings unguarded.
- **A touched conditional**: enumerate the FULL truth table of its inputs and
  test every cell, not only the branch you changed.
- **A broad `catch {}` / `rescue`** is a blast-radius amplifier — it turns a
  local throw into a silent, global failure. Test what throws INSIDE it, and
  narrow it if it swallows more than the one error it means to handle.

## Component-Test Floor (frontend)

When the change touches frontend components: for each user interaction it adds
or modifies whose handler contains logic beyond invoking a callback (branching,
state transitions, payload construction, validation), write a component test
that FIRES that interaction with a faithful mock and asserts the result. A
wired-through `onClick={onDelete}` needs no test — React invoking a prop is a
framework guarantee, not your behavior. Before wiring or
mocking any callback, read the REAL producer/consumer and match its actual
invocation shape (a callback may receive a functional updater `(prev) => next`,
not an array — see `.claude/workflows/prompts/contract-fidelity.md`
§ "Contract research"). Render-only coverage of an interactive component is not
enough — the interaction itself must be driven. A component test needs no seed
data, browser, or env, so there is no excuse to skip it.

## User's Request

$ARGUMENTS

## How to Execute This Skill

Execute the phases below in order. Each phase builds on the previous one.

### Phase 1: Gather Context

Read [phase-1-gather-context.md](phase-1-gather-context.md) and execute it.

This phase extracts:
- All code changes on the current branch (committed + uncommitted)
- User prompts from the full session transcript (including beyond compaction)
- Referenced source material (plan docs, issue descriptions, etc.)

### Phase 2: Identify Intent

Read [phase-2-identify-intent.md](phase-2-identify-intent.md) and execute it.

This phase determines:
- What kind of change this is (feature, bugfix, perf, refactor, etc.)
- What the user intended the change to accomplish
- What success looks like from the user's perspective
- Edge cases and failure modes worth testing

### Phase 3: Design Tests

Read [phase-3-design-tests.md](phase-3-design-tests.md) and execute it.

This phase:
- Designs test cases matched to the identified intent
- Ensures all tests are deterministic and non-flaky
- Follows existing test patterns in the codebase
- Presents the test plan, then proceeds to Phase 4 WITHOUT waiting for approval
  (only stop to ask if the plan hinges on a genuine product-behavior question —
  in that case ask that specific question, batched with any others)

### Phase 4: Write & Verify Tests

Read [phase-4-write-and-verify.md](phase-4-write-and-verify.md) and execute it.

This phase:
- Writes the tests planned in Phase 3
- Runs them to confirm they pass
- Verifies tests catch real regressions (mutation check)
- Launches a subagent review for flakiness (especially timing) and correctness
- Fixes any issues found during review
- Runs linters to confirm compliance
- Iterates until green

## Completion Checklist (MANDATORY — verify before declaring done)

You are NOT done with this skill until ALL of these are true. Do not skip any
of them for "small" or "obvious" tests — inconsistent gating is how bad tests
slip through:

1. Every new/changed test has been run and passes.
2. The mutation check ran for every new test (test fails when the behavior it
   pins is broken) — AND each test answers a second question: does it pin a
   *decision* someone could get wrong, or does it restate a declaration? A
   constant-restatement test passes mutation (edit the constant, test fails)
   and is still worthless. If the only way the test fails is someone
   deliberately editing the line it restates, cut it.
3. **The flakiness & correctness subagent review (Phase 4, Step 4) was launched
   and its findings addressed.** This review is required on EVERY invocation
   that produced tests — it is not conditional on test count or perceived risk.
4. Linters pass on the changed files.
5. Any commit containing tests from this skill carries `Test-Skill: add-tests`
   and `Test-Model: <your model id>` trailers, so test provenance is auditable
   with `git log --grep` instead of archaeology.
