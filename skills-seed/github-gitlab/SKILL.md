---
name: github-gitlab
description: Work with GitHub and GitLab repositories through resident gh/glab/git auth on the agent computer.
requiredCapabilities:
  - egress:github.com
  - egress:api.github.com
  - egress:gitlab.com
---

# GitHub / GitLab

Use this skill when the user asks to inspect repos, issues, pull requests, merge
requests, code history, branches, or to make a small code change in a hosted repo.

## Choose the account deliberately

Use the current credential manifest to choose an account authorized for this conversation
that fits the user's intent. Personal and shared accounts are both valid choices; neither
is an automatic fallback when the other fails. If the intended account is unclear before
a write, ask. Do not infer permission from a login merely being present on the computer.

- **Personal login:** use the authorized `gh`, `glab`, or Git login. Check the active
  provider account (for example, `gh api user --jq .login`) and the Git transport's auth
  configuration; a CLI API identity alone does not prove which account Git will use.
- **Shared org credential:** if listed in the prompt, select its slug and use the
  core-hosted smart HTTP remote in the `use-shared-credential` skill. This uses
  the configured shared account, even when a personal OAuth connector is live.
  Its name is an admin label, not a verified upstream username.
- **Connected app:** use only advertised capabilities. API access does not by itself
  establish native Git transport access or configure the CLI's active login.

For an existing checkout, inspect the remote and applicable credential-helper, SSH,
proxy, and HTTP-header configuration. A reused checkout
may still select a previous account. Commit author metadata is separate from transport
identity. Resolve an unknown identity before a write; do not probe access by pushing.

## Logging in

Use the native login only after an explicit authentication rejection. A TLS timeout,
connection reset, rate limit, or GitHub server error is not evidence of logout or
permission expiry. Do not consume another credential grant to repair transport.

For a confirmed missing or expired GitHub login:

```bash
gh auth login
```

The platform recognizes this device-flow login and runs it as a **durable process
session** (ADR 0002): it prints the one-time code + verification URL immediately and keeps
polling on the agent computer across turns — it does not block your turn or die at
teardown. Give the user the code and URL, ask them to approve in the browser, then say
"done". On the next turn, run `gh auth status` (or `gh auth login` again): the platform
reports you're authenticated once approval completes, and the login self-expires if the
user takes too long (just run `gh auth login` again to restart). GitLab is the same with
`glab auth login`.

## Read-only work

Check auth and inspect repo state:

```bash
gh auth status
gh repo view OWNER/REPO --json name,description,url,defaultBranchRef
gh issue list --repo OWNER/REPO --state open --limit 20
gh pr list --repo OWNER/REPO --state open --limit 20
```

For GitLab:

```bash
glab auth status
glab repo view GROUP/PROJECT
glab issue list --repo GROUP/PROJECT
glab mr list --repo GROUP/PROJECT
```

Use `git log`, `git show`, and `git diff` for codebase-change summaries. Cite commit
hashes, PR/MR numbers, and links.

## Checkout and edits

Clone or fetch only the repo the user asked for:

```bash
gh repo clone OWNER/REPO repo
cd repo
git checkout -b codex/small-change
```

Keep changes scoped. Run the repo's tests. If a push or PR/MR creation is requested,
prepare the branch and summary first.

## Writes require approval

Pushing branches, creating PRs/MRs, merging, closing issues, editing labels, changing
repo settings, releases, or workflows are writes. Ask for approval before running the
write command.

After approval:

```bash
git push -u origin codex/small-change
gh pr create --repo OWNER/REPO --title "..." --body-file pr.md
```

For GitLab:

```bash
git push -u origin codex/small-change
glab mr create --repo GROUP/PROJECT --title "..." --description-file mr.md
```

Report the final URL and leave enough context for review.

## Wait for GitHub CI

Use the bundled helper instead of a bare `gh pr checks --watch` or a handwritten
shell loop. It is one blocking watcher process, not repeated agent turns:

```bash
node skills/github-gitlab/scripts/watch-ci.mjs --repo OWNER/REPO --pr NUMBER --head REVIEWED_HEAD_SHA
```

Capture the full head SHA from `gh pr view NUMBER --repo OWNER/REPO --json headRefOid`
before review. Use that same SHA for the watcher and the final merge gate. Start the
watcher with the background-process tool and subscribe to its completion. Keep one
watcher per PR. Set the process lifetime longer than the helper's 30-minute deadline;
use `--timeout-ms` for a different bounded deadline. Use only credentials authorized
for that background process; a live foreground grant does not authorize background work.

The helper polls GitHub internally and emits JSON status records. It retries only
recognized transient transport/server errors with bounded backoff. Pending checks
remain pending. Real CI failures, authentication/authorization failures, changed heads,
unknown errors, exhausted retries, and deadline expiry all stop with nonzero status.
Explicit API rate limits stop as `rate_limited`, not authentication errors.
Empty check sets, skipped checks, and cancelled checks are not successful evidence.
Do not interpret an exit code alone as "checks concluded": read the status record.
Do not suppress a nonzero exit or print a success marker after it. Keep `set -e`.

Success means the checks observed for the expected head passed, not permission to
merge. Re-read checks and review threads immediately before merging. Wait for async
reviewers on that exact head; resolve findings and obtain a fresh-context adversarial
review. After any push or head change, discard old success/review evidence and repeat.
Only merge when all gates pass, with GitHub's atomic head guard:

```bash
gh pr merge NUMBER --repo OWNER/REPO --squash --match-head-commit REVIEWED_HEAD_SHA
```

Never use auto-merge or bypass repository gates. This helper does not retry GitLab
commands or change their authentication behavior.
