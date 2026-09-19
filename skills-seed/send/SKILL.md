---
name: send
description: Make a PR, wait for CI with bounded transport retries, independently review, and merge only when all gates pass.
requiredCapabilities:
  - egress:github.com
  - egress:api.github.com
  - egress:gitlab.com
---

# Babysit

Make a pull request for the change we just discussed, file it, babysit CI, fix
any issues that come up, and merge once CI is **fully** green.

## Steps

1. **Make the PR.** Commit the discussed change on a feature branch (create one
   off the default branch if currently on it). Push it.

2. **File it.** Open a pull request with a clear title and description covering why and what changed. Use `gh` for GitHub or `glab` for
   GitLab. Detect from the remote.

3. **Wait for CI in one blocking process, with bounded transport retries.**
   Load the `github-gitlab` skill; it reports the directory holding its scripts. For
   GitHub, capture the PR's full head SHA and use its bundled helper, not bare
   `gh pr checks --watch`:

   ```bash
   node <github-gitlab dir>/scripts/watch-ci.mjs --repo OWNER/REPO --pr NUMBER --head REVIEWED_HEAD_SHA
   ```

   Run this in the background with authorized credentials and subscribe to completion.
   Keep one watcher per PR; hand off if another agent already owns it. The helper
   polls internally, retries recognized transport/server errors with bounded backoff,
   and has a 30-minute overall deadline. Set the background lifetime longer than that.
   Do not wake the model repeatedly to report pending checks.

   Read the helper's JSON status, not just the exit code. Pending is not failure;
   TLS timeouts and connection resets are not logout or permission expiry. Failed
   checks, auth failures, rate limits, unknown errors, exhausted retries, and deadlines all
   remain nonzero. Keep `set -e`; never mask failure with a success marker or merge.
   A changed head invalidates successful checks and reviews: restart both on the
   new SHA. Empty, skipped, or cancelled checks do not count as success.

   For GitLab, use `glab ci status --live`; the GitHub helper does not cover it.
   Preserve its nonzero status and investigate failures before proceeding.

   Also wait for asynchronous reviewers (including Bugbot) to finish on the latest
   commit. Watcher success alone is never approval to merge.

4. **Adversarially review the PR — always in a fresh context, before merging.**
   Dispatch an independent subagent (or `/code-review`) that has not seen you
   write the change. **Never review your own diff in the context that produced
   it** — that context already believes the change is correct, and that belief is
   exactly the bias review exists to defeat. A fresh reviewer is non-negotiable on
   every send, however small the diff and however green CI is.

   What scales with risk is the reviewer's **depth and breadth**, not its
   independence:

   - **Small, well-tested, single-file change:** one reviewer, modest effort,
     scoped to the diff and its immediate call sites. Cheap, but still a
     stranger's eyes.
   - **Risky change** — core control flow, auth/credentials/security, data loss or
     migrations, concurrency and retry logic, spend, a public API contract, or a
     diff too large to hold in your head: high effort, wider blast-radius reading,
     and consider several reviewers with distinct lenses (correctness, security,
     does-it-actually-reproduce).

   Prompt the reviewer to _break_ the change: correctness bugs, edge cases,
   regressions, security holes, violations of the repo's CLAUDE.md/spec,
   **overengineering** (needless abstraction, flags, layers, or generality for one
   caller — prefer the simplest thing that works), and **reward hacking** (tests
   weakened, skipped, or tailored to pass rather than to verify; assertions
   gutted; intent met in letter but not spirit; CI gamed). Treat the diff as
   guilty until proven correct. Green CI is not review.

5. **Fix every real issue found.** Address each genuine finding from the
   adversarial review, from CI, and from reviewers/bots: fix it, push, and go
   back to step 3. Re-review the **delta**, not the whole diff again — a fresh
   full review per round is how a small PR turns into an afternoon. For anything
   that needs human judgment, ask the user. Cap at ~3 fix rounds, then stop and
   report what's unresolved.

6. **Merge once green AND reviewed.** Merge only when all checks pass, the
   adversarial review is clean (no unaddressed findings), and there are no
   unresolved comments/findings — re-read checks and review threads, then merge directly
   (`gh pr merge NUMBER --repo OWNER/REPO --squash --match-head-commit REVIEWED_HEAD_SHA` /
   `glab mr merge --squash`). Do **not** use platform auto-merge — it fires the
   moment required checks pass, before async bots like Bugbot finish and before
   your review is done.

## Notes

- "Pull request" = PR/MR; same thing on either platform.
- The review is non-optional on every send, and always runs in a fresh context —
  what scales with risk is how deep the reviewer goes, never whether it's someone
  other than the author.
- Don't merge with open Bugbot/reviewer findings on the current commit.
- Weight human feedback over bot feedback; don't blindly accept everything.
- Prefer rebase over merge for conflicts. Never amend commits.
- **Verify locally with the affected tests, not the whole suite.** Run the tests
  covering what you changed, plus typecheck and lint, then push and let CI be the
  full gate. CI shards the suite across parallel runners; reproducing that
  serially on one machine can cost 4x the wall clock for the same signal. Run the
  full suite locally only when the change is broad enough that you can't tell
  which tests are affected.

## Installed skill overrides

This workflow uses the `github-gitlab` seed skill's bundled watcher. Existing
user-authored skills with the same name are not overwritten by seed installation.
If an installed `send` or `github-gitlab` skill still says to use bare `gh --watch`,
update that managed skill explicitly with its owner's approval. Do not claim an
upstream merge updates already-published custom skills or running watcher scripts.
