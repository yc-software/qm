---
name: send
description: Make a PR, wait for CI with bounded transport retries, run the repo's required reviews, and merge only when all gates pass.
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

   Run this with `execute`, an explicit `sandbox_id`, `background:true`, and authorized
   credentials; subscribe with `background` action `watch` and the returned `process_id`.
   Keep that sandbox ID throughout the checkout, checks, and push.
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

4. **Run the reviews the repo requires.** Follow the review process in the
   repo's AGENTS.md or CLAUDE.md on the current head.

5. **Fix every real issue found.** Address each genuine finding from the
   repo's reviews, from CI, and from reviewers/bots: fix it, push, and go
   back to step 3. Re-review the **delta**, not the whole diff again — a fresh
   full review per round is how a small PR turns into an afternoon. For anything
   that needs human judgment, ask the user. Cap at ~3 fix rounds, then stop and
   report what's unresolved.

6. **Merge once green AND reviewed.** Merge only when all checks pass, the
   required reviews are clean (no unaddressed findings), and there are no
   unresolved comments/findings — re-read checks and review threads, then merge directly
   (`gh pr merge NUMBER --repo OWNER/REPO --squash --match-head-commit REVIEWED_HEAD_SHA` /
   `glab mr merge --squash`). Do **not** use platform auto-merge — it fires the
   moment required checks pass, before async bots like Bugbot finish and before
   your review is done. On a branch that requires a merge queue, that command
   queues the PR instead; report it merged only once the PR shows as merged.

## Notes

- "Pull request" = PR/MR; same thing on either platform.
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
