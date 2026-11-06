# Coding Standards

Rules code in this repository follows: defect classes authors must avoid while writing and reviewers can see in a diff. Automated linter, typecheck, and formatting checks belong in CI rather than this document.

## Architecture and State

- **Durable by default**: Never stash state that the system later relies on in process memory (`Map`, array, or set). Core runs multi-instance and blue-green; memory is wiped on deploy. Back persistent state, audit trails, and queues with Postgres. In-memory storage is acceptable solely as a transient cache or for genuinely disposable state.
- **Solve at the layer all paths flow through**: When fixing a pattern, place the fix in shared helpers (`src/util/errors.ts`, `src/util/async.ts`, `src/util/sweeper.ts`, `src/sandbox/process-poll.ts`, `src/memory/notebook.ts`), store interfaces, or base modules rather than patching isolated call sites. Fix every instance across `src/`, `plugins/`, `test/`, and `scripts/`.
- **God files**: Avoid letting single files accumulate unrelated responsibilities (e.g., mixing transport routing, business domain logic, and auth flows). Preserve explicit module boundaries.
- **Clean cutovers over compatibility shims**: Do not preserve dead paths, string-matching shims on legacy identifiers, or dual read/write layers to support old formats. Make clean breaking migrations and drop obsolete columns or shapes.

## Code Style and Hygiene

- **Zero comments**: Never commit comments in the codebase—no explanatory comments, docblocks, TODO/FIXME markers, lint/type suppression directives, or commented-out code. Express intent through clear naming, structure, and automated tests; document rationale in commit messages and PR descriptions.
- **Simplifying fixes**: Every fix should aim to shrink the surface area of the system rather than adding new flags, layers, or special-case branches.
- **Avoid ad-hoc regex parsing**: Do not parse structured strings, shell commands, or protocol payloads with regular expressions when typed inputs or parser helpers exist.

## Safety and Reliability

- **No arbitrary limits**: Do not introduce arbitrary bounds (counts, character limits, timeouts, retry counts) without a documented external constraint (provider API limit, DB column bound). When bounding is necessary, fail loudly or page rather than silently truncating.
- **Preserve error evidence**: Never swallow exceptions or replace detailed underlying errors with generic error strings. Ensure original causes propagate to durable error logs.

## Frontend and UI

- **Consistent UI**: Reuse existing shared components and typography tokens across surfaces (e.g. web UI, admin UI, Browse views) rather than introducing surface-specific chrome or font overrides.
- **No explaining-away copy**: Never add UI notices, tooltips, or toasts justifying a quiet reroute or refusal when the underlying interaction rule is what needs fixing.

## Maintaining this file

A defect class enters this file only when it appeared in a review finding the author fixed, a fix commit, a cleanup that removed it across the codebase, or a solution record, and no automated check covers it. State rules as enduring conditions grouped by area.
