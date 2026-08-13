---
date: 2026-08-08
pr_kind: chore
pr_title: "chore: drop portal-fix files (covered by upstream PR #287)"
upstream_pr_287: https://github.com/yc-software/qm/pull/287
keeps_pr_245: https://github.com/yc-software/qm/pull/245
local_fork_path: /Users/kenneth/AG_Mission/qm
patch_commit_portal_fix: 20e0f43
patch_commit_local_only: e5b2e19
patch_commit_local_backend: 7312686
gated_on:
  - yc-software merges PR #287 on github.com/yc-software/qm
  - yc-software publishes a portal image to ghcr.io/yc-software/qm/portal that includes PR #287's fix
  - image tag is verified equivalent to or newer than the local fork's 20e0f43 patch
intended_post_date: TBD-when-upstream-merges
post_target_branch: RollingStonie/qm:main
---

# chore: drop portal-fix files (covered by upstream PR #287)

## Summary

The local fork holds 3 commits + 1 uncommitted change that diverges from
`origin/main`. After upstream merges PR #287, the **portal-fix files
can be dropped** — the local fix is duplicated by `wsr3005`'s upstream
contribution. The `--local-only` flag work (PR #245) and its companion
commit stay in the fork; they are NOT touched by this cleanup.

## File split (corrected 2026-08-08)

| File | Reason | Action |
|------|--------|--------|
| `cli/src/cli.ts` | PR #245 (--local-only flag) | **KEEP** |
| `cli/src/commands/sandbox.ts` | PR #245 (--local-only flag) | **KEEP** |
| `cli/test/sandbox-local-only.test.ts` | PR #245 (test) | **KEEP** |
| `cli/src/backends/registry.ts` | companion `sandbox.backend: "local"` (7312686) | **KEEP** (probably belongs in PR #245 or PR #287 — review with Kenneth) |
| `cli/src/commands/check.ts` | companion (7312686) | **KEEP** (review) |
| `cli/src/config.ts` | companion (7312686) | **KEEP** (review) |
| `plugins/portal/src/index.ts` | local portal fix (20e0f43) — **DUPLICATED by PR #287** | **DROP** |
| `plugins/portal/test/broker-proxy.test.ts` | local portal fix (20e0f43) | **DROP** |
| `deploy/core/Dockerfile` | uncommitted: drops `npm audit` (transient fix) | **DECIDE** — keep as a separate commit if npm audit still fails; revert if it passes |

## Why this is safe

- PR #287 (from `wsr3005`) addresses the same `isPrivateNetworkUrl` /
  private OIDC broker hostname validation that the local 20e0f43 fixes.
  Once merged, the local portal-fix files are dead code.
- The local CLI changes (PR #245 + companion) are NOT covered by PR #287
  and stay in the fork.
- The uncommitted Dockerfile change is independent — verify `npm audit`
  passes against upstream's published image before reverting.

## Revert plan

```bash
# 1. Drop the portal-fix files (only 2 files — surgical)
git checkout 20e0f43^ -- plugins/portal/src/index.ts \
                                plugins/portal/test/broker-proxy.test.ts
git status --short   # should show only the 2 portal files

# 2. Commit the drop
git commit -m "chore: drop local portal fix (upstream PR #287 merged)

The local fork's plugins/portal/src/index.ts and broker-proxy.test.ts
duplicate the fix in yc-software/qm PR #287 (wsr3005). Once
upstream publishes a portal image with PR #287, the local fix
is dead code.

Local fork keeps: cli/* (PR #245 --local-only + companion commits).
Local fork drops: plugins/portal/* (PR #287 covers them).

Co-Authored-By: Claude <noreply@anthropic.com>"

# 3. Verify clean state
git status --short   # should be empty
git diff origin/main -- plugins/portal/   # should be empty
git diff origin/main -- cli/             # should still show the 6 cli files
```

## Dockerfile decision (separate)

Before committing the Dockerfile change, run:

```bash
# Sanity check: does the published image's npm audit pass?
docker pull ghcr.io/yc-software/qm/portal:<upstream-tag>
# If the build succeeds without the local `npm audit` removal, the
# Dockerfile change is no longer needed — revert it.
git checkout HEAD -- deploy/core/Dockerfile
```

If `npm audit` STILL fails transiently, keep the Dockerfile change as a
separate commit:

```bash
git add deploy/core/Dockerfile
git commit -m "chore: drop npm audit step in Dockerfile (transient failure workaround)

Local fork keeps this only if upstream's published image still has
the same audit transient. When upstream stabilizes, revert this in
a follow-up cleanup.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

## Verification steps

After the portal-file drop lands on the fork:

1. **Confirm upstream publishes.** Pull `ghcr.io/yc-software/qm/portal:<upstream-tag>`
   and verify PR #287's fix is in the image's built CLI:
   ```bash
   docker pull ghcr.io/yc-software/qm/portal:<upstream-tag>
   docker run --rm ghcr.io/yc-software/qm/portal:<upstream-tag> \
     sh -c 'cd /app && grep -l "single-label" /app/plugins/portal/src/index.ts'
   ```

2. **Boot the stack.** `qm up` against the published image — confirm
   the stack reaches healthy without the local portal fix.

3. **OIDC smoke.** Walk through the OIDC flow that previously required
   the local fix. Confirm it succeeds.

4. **CLI parity.** Run `qm sandbox publish --local-only` against the
   published image — confirm the PR #245 feature still works (it
   doesn't depend on the portal fix).

## Rollback

If anything breaks after the cleanup:

```bash
git revert <cleanup-commit-sha>   # adds back the local portal fix
```

## Status

- **NOT EXECUTED.** Gated on upstream PR #287 merge.
- Local fork working tree has 1 uncommitted change
  (`deploy/core/Dockerfile`) that needs a separate decision when
  upstream stabilizes.
- Local fork state: 3 commits vs origin/main (e5b2e19, 7312686, 20e0f43)
  + 1 uncommitted Dockerfile change.
