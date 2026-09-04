---
name: update-qm
description: Update a private qm fork by merging upstream qm into it and opening a sync PR. Use when asked to "update qm", "sync from upstream", "pull in the latest qm".
---

# update-qm

An organization customizes qm from a private fork: a standalone private repository whose
history begins as a clone of qm, with everything organization-specific confined to
`deploy/layers/<org>/` and the rest of the tree identical to upstream. That rest is what
this skill means by core: every file outside the organization's layer directory,
including the plugins, the CLI, the docs, and CI, not just the runtime under `src/`.
This skill keeps a private fork current. It merges upstream qm in and opens the
resulting sync PR.

See [`deploy/layers/README.md`](../../../deploy/layers/README.md) for the layer boundary,
and the `upstream-pr` skill for sending changes the other direction.

## Check that there is anything to sync

```bash
git remote -v
```

If `origin` is `yc-software/qm`, stop: you are in upstream qm, and a repository
cannot merge from itself. Never merge an organization's private fork into qm.

Otherwise proceed. Judge by where `origin` points, not by the repository's name.

If the clone has no `upstream` remote, add it:

```bash
git remote add upstream git@github.com:yc-software/qm
```

## Merge, never rebase

`origin/main` is published history that deploys and other clones track. Rebasing it onto
upstream rewrites those commits, so always merge.

```bash
git switch main
git pull --ff-only origin main
git fetch upstream
git switch -c sync-upstream-<yyyy-mm-dd>
git log --oneline main..upstream/main
git merge upstream/main
```

Record the commit range before resolving anything so the PR can state it. If the merge
reports "Already up to date", delete the branch and report that instead of opening an empty
PR.

## Resolving conflicts

A merge conflict needs both histories to change the same path, and upstream has no files
under `deploy/layers/<org>/`, so an organization's layer cannot conflict with a sync.
Upstream changing the layer contract does not conflict either; it surfaces as a `qm check`
failure, covered below. Every conflict in a sync therefore means the private fork edited a
file that exists in upstream qm, which the layer boundary exists to prevent. For each such
file, decide which happened:

- The edit is organization-specific and should never have been in core. Take upstream's
  side, then move the customization into `deploy/layers/<org>/`.
- The edit belongs in core qm for everyone. Resolve in whichever direction keeps the tree
  working, then use the `upstream-pr` skill to send it to qm so the next sync stops
  conflicting on it.

List these files in the PR description either way. A private fork that accumulates core edits
gets more expensive to sync each time, and the sync PR is where that cost should be
visible.

## Verify before opening the PR

A sync changes the runtime, the CLI, and possibly the deployment contract at once, so run
everything. The root suite does not cover the CLI, and the CLI is where a contract change
lands:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm --prefix cli test
```

A sync can raise the deployment contract major, and the CLI rejects a layer config written
for the old one. Check each organization layer with the in-tree CLI (`npm exec qm` does not
work in a source checkout; the workspace symlink points at `cli/`, which is unbuilt):

```bash
node cli/bin/qm.ts check --config deploy/layers/<org>/qm.config.jsonc
```

If that reports an unsupported contract major, updating the layer config to the new shape
is part of this sync.

## Open the PR

```bash
git push -u origin sync-upstream-<yyyy-mm-dd>
gh pr create --repo <private-fork> --base main \
  --title "Sync upstream qm through <short-sha>" \
  --body-file .generated/sync-body.md
```

Pass `--repo` to every `gh` command you run in a private fork. Without it, `gh` picks a base
repository from the clone's remotes and may choose `upstream`: the sync PR gets opened
against qm, and `gh pr edit 1` overwrites whatever PR is number 1 in the source repository.
The same applies to `gh pr view`, `gh pr list`, and `gh issue`.

The description should state the upstream commit range merged, any file outside
`deploy/layers/` that conflicted and how it was resolved, and the results of the checks
above.

If the private fork deploys from `main`, merging this PR ships upstream's changes to production,
so merge when someone can watch it.

A private fork runs upstream's CI workflows in the organization's own account. A sync that
adds or changes CI changes what runs on the next PR, and workflows that need secrets the
fork never received will fail until those are supplied.

## Never do these

- `git push --mirror` to an existing private fork. It deletes refs the destination has and the
  source does not, discarding the organization's own branches. It is safe only for the
  first population of an empty repository.
- Pushing a branch whose history contains organization commits to upstream. The
  `upstream-pr` skill pushes upstream only from branches cut fresh from `upstream/main`
  and scrubbed.
- Rebasing `main` onto `upstream/main`, or force-pushing a private fork's `main`.
- Resolving a conflict by deleting the upstream side wholesale to quiet the merge. That
  silently diverges core from upstream, and the divergence returns as a larger conflict in
  the next sync.
