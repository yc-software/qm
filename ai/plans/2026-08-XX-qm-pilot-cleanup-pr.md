---
date: 2026-08-07
pr_kind: chore
pr_title: "chore: revert local fork patch (upstream PR #245 merged)"
upstream_pr: 245
upstream_pr_url: https://github.com/yc-software/qm/pull/245
patch_commit: 20e0f43
patch_branch: fork/worktree-portal-isPrivateNetworkUrl-v1
patch_commit_message: "fix(portal): admit docker-compose service hostnames in isPrivateNetworkUrl"
gated_on:
  - yc-software merges PR #245 on github.com/yc-software/qm
  - yc-software publishes a portal image to ghcr.io/yc-software/qm/portal that includes 20e0f43
  - image tag is verified equivalent to or newer than the local fork's 20e0f43 patch
intended_post_date: TBD-when-upstream-merges
post_target_branch: origin/main
revert_files:
  - cli/src/backends/registry.ts
  - cli/src/cli.ts
  - cli/src/commands/check.ts
  - cli/src/commands/sandbox.ts
  - cli/src/config.ts
  - cli/test/sandbox-local-only.test.ts
  - deploy/core/Dockerfile
  - plugins/portal/src/index.ts
  - plugins/portal/test/broker-proxy.test.ts
verification_steps:
  - pull ghcr.io/yc-software/qm/portal:<upstream-tag> and confirm 20e0f43 is in the image
  - run `qm up` against the published image; confirm stack boots end-to-end
  - confirm OIDC flow (auth broker hostname) succeeds without the local fix
  - run `npm audit --omit=dev --audit-level=moderate` against the published image; confirm it does not error (the Dockerfile fix only kicks in if the audit regresses)
  - run the local 4-test smoke from `tests/local/` (or its successor) for parity
rollback_command: "git revert <cleanup-commit>"
---

# chore: revert local fork patch (upstream PR #245 merged)

## Summary

This PR reverts the local fork-only patch held on `fork/worktree-portal-isPrivateNetworkUrl-v1`
(commit 20e0f43) plus the uncommitted `deploy/core/Dockerfile` change that drops the
`npm audit` step. The upstream portal image now ships the fix (PR #245), so the local
fork-only patch is no longer needed.

Once merged, `qm up` against the published image should behave identically to the local
fork build, and the local fork patch + Dockerfile change can be dropped.

## Why this is safe

The upstream fix (PR #245) and the local Dockerfile change are both targeted narrowly at
the docker-compose-based `qm up` flow. Neither modifies persistent state, neither touches
the application logic, and both are scoped to the same edge case (docker service
hostnames + npm audit transient failures). The image tag published upstream is
sufficient to replace the local override.

## Revert plan

9 files local-only vs `origin/main`:

| File | Patch lines | Source |
|------|-------------|--------|
| `cli/src/backends/registry.ts` | +2 / -2 | commit 20e0f43 |
| `cli/src/cli.ts` | +11 / -4 | commit 20e0f43 |
| `cli/src/commands/check.ts` | +5 / -2 | commit 20e0f43 |
| `cli/src/commands/sandbox.ts` | +76 / -18 | commit 20e0f43 |
| `cli/src/config.ts` | +14 / -5 | commit 20e0f43 |
| `cli/test/sandbox-local-only.test.ts` | +143 / -0 | commit 20e0f43 (new file) |
| `deploy/core/Dockerfile` | +1 / -2 | uncommitted working tree |
| `plugins/portal/src/index.ts` | +5 / -1 | commit 20e0f43 |
| `plugins/portal/test/broker-proxy.test.ts` | +5 / -1 | commit 20e0f43 |

**Recommended revert (single commit):**

```bash
# 1. Drop the uncommitted Dockerfile change first
git checkout HEAD -- deploy/core/Dockerfile

# 2. Revert the local fork commit
git revert --no-edit 20e0f43

# 3. Verify clean state
git status --short   # should be empty
git diff origin/main --stat   # should be empty
```

The `git revert` approach preserves the local fork commit in history (so it can be
referenced if we want to reapply later), and applies it as a single cleanup commit on
the fork's main branch.

**Alternative: rebase fork from upstream (cleaner history).**

```bash
git fetch origin
git reset --hard origin/main   # WARNING: nukes local fork state. Only safe if the
                               # 4 AHEAD commits + uncommitted Dockerfile change
                               # are first pushed to a backup branch.
```

The revert path is preferred because it preserves the audit trail and avoids
history rewriting on a published branch.

## Verification steps

After the cleanup commit lands on the fork:

1. **Confirm upstream publish.** Pull `ghcr.io/yc-software/qm/portal:<upstream-tag>`
   and verify commit `20e0f43` (or newer with the same fix) is in the image's
   built CLI:
   ```bash
   docker pull ghcr.io/yc-software/qm/portal:<upstream-tag>
   docker run --rm ghcr.io/yc-software/qm/portal:<upstream-tag> \
     sh -c 'cd /app && git log --oneline | grep -E "isPrivateNetworkUrl|20e0f43"'
   ```

2. **Boot the stack.** `qm up` against the published image — confirm the stack
   reaches healthy without the local fork patch.

3. **OIDC smoke.** Walk through the OIDC flow that previously required the fix
   (docker-compose auth broker hostname). Confirm it succeeds without the local
   override.

4. **Audit regression check.** Trigger the npm audit path against the published
   image. If the published Dockerfile retains the audit step, the build should
   succeed without the local override. If the audit transient-regresses, the
   Dockerfile change can be re-applied as a separate, documented commit
   (NOT mixed with the PR #245 revert).

5. **Test parity.** Run the local 4-test smoke that validated the local fork
   (resolved end-to-end on 2026-08-06). Confirm parity against the published
   image.

## Rollback

If anything breaks after the cleanup:

```bash
git revert <cleanup-commit-sha>   # adds back the local fork patch
# OR
git reset --hard <commit-before-cleanup>   # nukes the cleanup, more nuclear
```

The revert path is preferred. The reset path is only safe if the cleanup commit
has not been pushed.

## Linked

- yc-software/qm PR #245 — the upstream contribution that makes this cleanup safe
