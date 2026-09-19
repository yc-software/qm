# Contract & Coverage Fidelity

Canonical directives for the work-ticket pipeline. `work-ticket-understand.js` and
`work-ticket-build-and-ship.js` instruct their agents to read this file at run time, so
there is exactly one copy to edit and the two pipelines can never drift.

Provenance: a shipped crash occurred because the code and its test mock treated a
callback's real contract (a functional updater `(prev) => next`) as a plain array, the
crashing interaction was never enumerated as a user story, and missing seed data made the
flow silently unreachable during proof. Each section below closes one of those holes.

## Contract research

Before you wire OR mock any callback prop, event handler, or API this change touches,
open the REAL producer/consumer and match its actual shape:

- Quote (a) the declared type and (b) how it is actually invoked. A React callback like
  `onLinesChange` may be called with a functional updater `(prev) => next`, NOT an
  array — your code must handle every shape the real caller uses, and any test mock MUST
  reproduce that exact invocation at least once. A render-only mock of an interactive
  child (one that never fires its callbacks) is invalid.
- Not React-specific: a backend producer/consumer has the same trap (a serializer
  emitting `{ id, name }` vs a caller reading `record.title`; a job enqueued with
  positional args vs a `perform` expecting a hash). Read the real caller/callee and match
  the shape — do not assume.
- If the ticket says "mirror/copy/same as X", diff your implementation against X's
  analogous function and reconcile EVERY signature/contract difference — do not copy
  structure while dropping behavior.

## Interaction coverage

For each component the change touches, enumerate EVERY user interaction it exposes (each
editable field, each control that fires a callback: select/account change, input edit,
add/remove/reorder, submit), not just open→save. For each, state the expected state
change AND the data prerequisite to reach it (e.g. "needs a company with a chart of
accounts"). If the ticket references a feature to mirror, your stories must cover THAT
feature's interactions too. Quality is interaction/state coverage, not story count.

## Data readiness

Before driving a UI story, confirm the prerequisite data exists in dev. Local dev often
lacks seeded data (e.g. a chart of accounts), so a flow can be silently unreachable while
the happy path still screenshots fine. Satisfy the data via APP-CODE SEEDING: create the
records via the app's own modules and factories (a small script that imports them, never a
raw database write) after discovering the minimal object graph from the code. "Missing
seed data" is NOT an accepted reason to skip a story. The ONLY accepted reasons to not
browser-exercise an interaction are (a) a specific named third-party integration in the
path (payment, e-sign, external OAuth) or (b) genuinely un-synthesizable production
state — and even then exercise up to that boundary and name the exact reason. Never claim
a path is verified that you could not reach; state which interactions you actually
exercised.
