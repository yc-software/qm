# qm

**Read [`docs/SPEC.md`](./docs/SPEC.md) first.** It is the short source of truth for QM's north stars, subsystems and past mistakes. Where another doc disagrees, the spec wins.

To run and test, see [`README.md`](./README.md).

## Working on the code

Two habits that keep task-focused changes from scarring the rest of the repo:

- **Do not add AI authorship attribution to commits or pull requests.** Omit
  `Co-authored-by` trailers for Codex, Claude, or other AI tools, and omit
  tool-generated attribution footers such as `Generated with Codex`. Preserve
  legitimate human coauthors. CI rejects AI coauthor trailers on new PR commits;
  do not rewrite existing repository history to remove attribution.
- **Fix every instance, not just the reported one.** When you find a bug or a pattern
  worth changing, grep the whole repo (`src/`, `plugins/`, `test/`, `scripts/`) for the
  same pattern and fix all of it in the same change. One autocorrected call site with
  five untouched siblings is a regression waiting to be rediscovered.
- **Fixes should make the system simpler, not more complex.** Prefer removing or
  consolidating code over adding a new layer, flag, or special case. If a fix grows the
  system's surface area, look for the version that shrinks it.
- **Never leave comments in the repo.** The standard is zero comments: no explanatory
  comments or docblocks, TODO/FIXME notes, lint/type suppression directives, or commented-out
  code. Express intent through names, structure, and tests; put rationale in commit messages or
  PR descriptions. Interpreter shebangs are executable directives, not comments.
- **Solve at the layer all paths flow through.** Before patching a call site, ask
  whether the fix belongs in the shared helper, the store interface, or the base
  module instead. Check for an existing helper before writing a new one-liner.
  The helper homes: `src/util/errors.ts` (errMessage/swallow), `src/util/async.ts`
  (sleep, createKeyedQueue), `src/util/sweeper.ts` (periodic loops),
  `src/sandbox/process-poll.ts` (process polling/liveness), `src/memory/notebook.ts`
  (memory line grammar). Plugins are separate packages and keep their own local
  copies rather than importing core code — the one exception is the shared
  `plugins/chassis` package (the sanctioned home for the plugin↔core plumbing:
  source-auth signer, signed core-client, node:http helpers, error helpers, CORE_*
  env), imported by relative path and never importing core. The bar cuts both ways:
  don't manufacture an abstraction for a pattern with one caller.
- **Land PRs through the merge queue.** When a PR's checks and reviews pass,
  `gh pr merge <number>` queues it rather than merging it. The queue runs CI on the
  exact commit that will land, reusing the PR's run when `main` has not moved, and
  `main`'s own CI then reuses the queue's run. Never bypass the queue with `--admin`.
- **Check the plan against the Wall of shame before writing code.** A PR cannot merge
  until every relevant lens in the [Wall of shame](./docs/SPEC.md#wall-of-shame) accepts
  it, and a single finding under a lens blocks that. Before building, hold what you plan
  to add against each lens below and change the plan where it would draw a finding. Do the
  same for every fix you make during review: a fix that clears one lens by tripping
  another costs a round. Changing the plan is free; the same finding at review costs a
  rewrite. The spec holds each lens's full text and examples.
  - **Overengineering:** a subsystem, layer, flag, hook or option the change does not
    need. Prefer deleting; net-negative lines are rewarded.
  - **Band-aid fixes:** hiding a symptom with a special case, a string match or one more
    branch instead of fixing the cause.
  - **Duplication:** a second implementation or source of truth for something that
    already has an owner.
  - **Hand-rolling:** reimplementing what an SDK, library or supported API provides.
  - **Non-durability:** state the system relies on kept in process memory, not Postgres.
  - **Config-matrix expansion:** new env vars, settings or schema, and implicit modes
    picked by conditionals, text matching or flags.
  - **Historylessness:** shims, dual paths or special handling for old data shapes
    instead of one migration.
  - **Provider drift:** sandbox providers giving the agent different machines.
  - **God files:** one file or module taking on unrelated responsibilities.
  - **Mismatched UI:** interface that disagrees with the product around it instead of
    reusing its components.
  - **Over-indexing on YC:** architecture bent around YC's own usage.
  - **Regex:** reaching for regular expressions.
  - **YC info leaking into public qm:** organization-specific names, details or
    references in the public repository.
  - **Discarded error evidence:** replacing or swallowing a failure so it cannot be
    diagnosed.
  - **Arbitrary limits:** a cap, timeout or retry budget no real constraint requires.
  - **Explaining-away UI:** copy that justifies the UI not doing what the person asked.
  - **Category gate without census:** gating on a category without listing everything
    that falls into it.
  - **Over-testing:** net test lines above the source lines added; CI counts it.
  - **Prod-like QA:** a behavior change not exercised on the real system and the
    production path before merge.
  - **Performance:** unnecessary, repeated or serialized work, N+1 queries and
    unbounded reads.
  - **Token performance:** anything added to the system prompt or per-turn context that
    does not earn its place.
- **Run independent Wall of shame reviews in parallel for every PR.** First triage with
  one fast, cheap model, the latest Haiku: give it the diff and every lens in the current
  [Wall of shame](./docs/SPEC.md#wall-of-shame), and have it mark each lens relevant or
  not, keeping any lens it is unsure about. Lenses marked _always reviewed_ in the spec
  skip triage and always get a reviewer. Then dispatch a separate fresh-context
  subagent or independent reviewer for each relevant lens. Launch reviews asynchronously
  and in parallel within available capacity, queuing any overflow. Do not wait for
  reviews before opening or updating the PR, running checks, or continuing other work.
  Give each reviewer the raw evidence (diff, commands, logs, provider config), never the
  author's summary of it. Each reviewer follows the rules that open the Wall of shame,
  where findings decide the verdict; point it at them rather than restating them.
  Put each lens's verdict, with its reviewer's score and concise assessment, in the **PR
  description**, labeled by lens and reviewer and tied to the reviewed commit, and list
  every finding raised on the PR with how it ended, quoting any judge's ruling. Update
  the description as reviews arrive; mark pending reviews honestly and never invent
  results or substitute the author's self-review. After edits, have independent
  reviewers reassess affected lenses and explicitly carry forward unaffected results;
  never re-run a reviewer on unchanged code to get a different verdict.
  These reviews run alongside PR work; before merging, every relevant lens must have
  accepted. Only a human maintainer can waive a lens, for
  one PR: keep the reviewer's actual score, set the verdict to `Waived`, and write the
  assessment as `Waived by <name>:` followed by the objection that was waived. Never
  write a waiver the maintainer did not give, and never record one as Accept. The
  `Wall of shame review` CI check fails until the description's report covers every lens
  for the PR head: relevant lenses with an Accept or Waived verdict, and the rest as
  `Not relevant` with the triage model as reviewer and its one-line reason as the
  assessment. Lenses marked _checked by CI_ are computed by that check from the diff: skip
  them in triage and review, and give them a row only to record a waiver.
- **Disclose configuration changes in the PR description.** Name added, removed,
  or changed settings, flags, modes, and providers, including defaults, precedence,
  and supported combinations. Explain why; keep this proportional to the change.
- **Keep humans in the loop on schema and data types.** Humans must see and review
  changes to tables and persisted/API payload shapes. Surface them in chat and the
  PR description as you make them: complete affected old and new shapes, including
  keys, indexes, constraints, enum variants, and JSON fields, with representative
  before/after rows. Label invented examples. Account for every field kept, moved,
  transformed, or dropped; explain migration, backfill, rollout, and compatibility
  effects. Distinguish approved design, implemented code, and live schema. A migration
  diff alone is not enough. If configuration or schema is unchanged, say so explicitly.
- **Verify locally with the affected tests, not the whole suite.** Run the tests covering
  what you changed plus typecheck and lint, then push and let CI be the full gate — CI
  shards the suite across parallel runners, and reproducing that serially costs several
  times the wall clock for the same signal. Judge "affected" by callers rather than by diff
  size — a one-line edit to a helper with fifty importers reaches all fifty; run everything
  locally when you can't tell what a change reaches.
- **Test what a user or caller sees, never the source.** Run the code and assert on its
  output; don't assert on source text, CSS, or prompt wording. A bug fix's test must fail
  on the old code through the real path and assert the correct behavior, not the inverse
  of the specific fix. Don't write checks that can't fail — a fixture compared against
  itself, a job that always reports success. When a feature is removed, delete its tests.
  CI enforces the spec's Over-testing limit on test lines per PR; remove or reshape
  existing tests to stay within it.
- **Verify non-trivial behavior changes in a live dev instance before opening a PR.**
  When a change is substantial enough that unit tests alone won't prove it works
  end-to-end — new or changed agent behavior, or anything touching the Slack/web
  surfaces, orchestrator, directory, or cron flows — boot this worktree with the
  `/dev-instance` skill and exercise it through a browser against the configured Slack
  development workspace before opening a PR. Do this Slack QA in **Firefox**, never the
  Slack Mac app, and don't ask permission first — do it on your own; don't wait to be
  asked. Skip it for trivial refactors, docs, config, or pure-logic changes already
  covered by tests.
  Leave review instances running until the PR merges, unless the user asks to stop
  earlier. After merge, tear down that worktree's instance and verify its processes
  and lease are gone before removing the worktree. Preserve shared Postgres and
  persistent data. If the user asks to keep an instance beyond merge, keep its
  worktree too.
- **Keep screenshots out of Git and app assets.** Never commit screenshots or create
  a tracked screenshots directory, including under docs or QA. Capture review images
  in a temporary directory outside the checkout or an ignored local output directory,
  and attach them to the PR or host them externally. Do not bundle review screenshots
  into the app. Only actual product assets, such as icons and instructional media,
  belong in the app bundle. `.gitignore` ignores image files and CI fails when a tracked
  file is ignored; a product asset needs its own `!path` line there.
- **Demo every front-end change in the PR.** Anything an operator or user sees
  rendered — admin/web/portal UI, Slack surfaces, emails — ships with a way for a
  reviewer to see the result without booting it. Prefer a link to a live demo app
  (e.g. the built UI served against a small mock API, published internally) so the
  reviewer can click around the real thing; note in the PR what's mocked. Fall back
  to screenshots only when a live demo isn't practical (e.g. Slack surfaces, emails),
  and then show the after state (before/after for changes to something that existed),
  rendered against realistic data. Attach or externally host these screenshots; never
  commit them to satisfy this requirement.

## Deployment repositories and source forks

Before acting, run `git remote -v` and inspect the checkout. `origin` pointing at
`yc-software/qm` identifies upstream. Another origin alone does not identify a source
fork: a package deployment has its own `qm.config.jsonc` and pinned `@yc-software/qm`
dependency, while a source fork carries the QM source tree and upstream ancestry.

Package deployments customize config, tools, skills, and services without copying core.
Source forks may modify core freely, including runtime, plugins, CLI, docs, and CI;
contributing those changes upstream is optional. Keep private deployment material under
`deploy/layers/<org>/` in private source forks or in a separate private deployment
repository for public source checkouts. Secrets never enter Git. The README section
"Customize your instance" documents both paths and explicit source builds.

Create private source forks as standalone repositories outside GitHub's fork network.
Seed only `main` and set the default branch explicitly; never use `git push --mirror`.
Use `update-qm` to merge source updates without rebasing published history or discarding
intentional local changes. Land source-sync PRs without squashing or rebasing away their
upstream ancestry. Package deployments update their dependency instead.

In downstream repositories, pass `--repo` to every `gh` command so the upstream remote
cannot redirect an operation. When contributing from private work, use `upstream-pr`
to prepare a clean branch and scrub outgoing content and history. Never reference an
upstream issue or PR by number in private repository PRs, issues, comments, or commit
messages: GitHub cross-references can disclose their existence and titles upstream.
Name upstream work in plain words instead.

## Durable by default

A recurring mistake: stashing state the system later relies on in process memory. The
core runs blue-green and multi-instance — an in-memory `Map` or ring buffer is
per-instance and wiped by every deploy. Anything an operator or the system reads back
later (audit, logs, resolved config, queued or in-flight work) must live in a durable
store, never RAM alone. RAM-only is fine only as a cache in front of a durable store, or
for genuinely disposable, re-derivable state. If you're adding a log, audit, queue, or
resolved config, back it with Postgres; see the spec's “Free the brain” north star.

> `CLAUDE.md` is a symlink to `AGENTS.md`, so every tool (Claude Code, Codex,
> Cursor, …) reads the same guidance from this one file. If a tool-specific
> deviation ever becomes necessary, replace the symlink with a real file in the
> commit that introduces the deviation.
