---
name: upstream-pr
description: Send a change to upstream qm without leaking organization-specific context. Use when asked to "upstream this", "open a PR against qm", "contribute this back", or when a fix made in a private fork belongs in core qm.
---

# upstream-pr

An organization customizes qm from a private fork: a standalone private repository in
which everything organization-specific lives under `deploy/layers/<org>/` and the rest
of the tree stays identical to upstream. That rest is what this skill means by core:
every file outside the organization's layer directory, including the plugins, the CLI,
the docs, and CI, not just the runtime under `src/`. A private fork's working tree
therefore holds two kinds of material at once, and only one of them may travel upstream.

Upstream qm is shared with organizations other than yours, and anything pushed there is
permanent: it stays reachable by SHA in every clone and fork even after a deleted branch or
a force-push. Treat a leak as unrecoverable and spend the effort before the push.

See [`deploy/layers/README.md`](../../../deploy/layers/README.md) for the boundary, and the
`update-qm` skill for syncing the other direction.

## Where the branch will go

`git remote -v` tells you which of three situations you are in. This decides the push
target only; the scrub steps below run in every case.

- `origin` is `yc-software/qm`: you are in upstream qm. Push the branch to `origin`
  and open the PR there.
- `origin` is a GitHub fork of qm, meaning a repository created with GitHub's fork
  feature and living inside qm's fork network: push to `origin` and open a normal
  cross-repo PR.
- `origin` is anything else, including a repository with no remotes: treat it as a
  private fork. Assume the working tree holds organization material even if
  `deploy/layers/` looks empty, and read "Pushing from a private fork" below.

Judge by where `origin` points, not by the repository's name. A repository named
`<org>/qm-<something>` in the same GitHub organization as the source is still a private
fork.

## Decide whether the change belongs upstream

Ask what the change would mean to an organization that is not yours. It belongs upstream
when it is a fix or capability in core qm that any deployment would want. It does not
belong upstream when it only makes sense given how your organization is set up: its tools,
its vocabulary, its providers, its process. That change belongs in `deploy/layers/<org>/`.

A change that is generic in substance but written against org-specific fixtures needs its
fixtures rewritten first. Model them on the account-neutral fixtures under `deploy/stacks/`
rather than inventing values from your own deployment.

## Start from a clean tree and a clean branch

A branch cut from a private fork's `main` carries every organization commit in its history, and a
PR from it exposes all of them. Cut from upstream instead.

`git switch -c` carries modified and untracked files onto the new branch, where a later
`git add -A` sweeps them into the PR. So first require a clean tree; this must print
nothing:

```bash
git status --porcelain
```

Then:

```bash
git fetch upstream
git switch -c <topic> upstream/main
git cherry-pick <sha> [<sha>...]
```

If the change is entangled with organization commits and will not cherry-pick cleanly,
reimplement it on the clean branch. That is faster than auditing a messy history, and it
fails safe.

## Scrub

Run all four checks against the final branch state, and again after any amend or rebase.

The scans walk every commit rather than the net diff, because two ordinary moves defeat a
net diff. Moving a file out of `deploy/layers/` with `git mv` is recorded as a rename, so
the diff never shows its contents. Adding a layer file in one commit and deleting it in a
later one leaves the net diff empty, but the file still ships in the branch's history.
`git log -p --no-renames` sees both.

Capture the outgoing history once, into the gitignored `.generated/`:

```bash
mkdir -p .generated/upstream-pr
git log -p --no-renames \
  --format='commit %H%nauthor %an <%ae>%ncommitter %cn <%ce>%n%s%n%b' \
  upstream/main..HEAD > .generated/upstream-pr/outgoing.txt
```

**1. No layer paths in any commit.**

```bash
git log --name-status --no-renames --format='' upstream/main..HEAD \
  | grep -E 'deploy/layers/[^/]+/' || echo "PASS: no layer paths"
```

On any hit, stop and rebuild the branch. No PR to upstream legitimately touches an
organization's layer directory. The shared `deploy/layers/README.md` is core and may
change, which is why the pattern matches only paths inside an organization's
subdirectory.

**2. No organization identifiers in content, messages, or authorship.** Build the term list
by reading your own layer: `qm.config.jsonc` has the org slug and public URL host,
`.env.example` has the computed secret names, `.env` has the secret values,
`slack-app-manifest.yml` has workspace and app names, `infra/terraform.tfvars` has cloud
account and repository coordinates, and `sandbox/` has internal tool and system names. Add
your email domains, teammates' names, and any customer or partner names.

Authorship is scanned because a clone configured with an internal `user.email` stamps it on
every commit, and it stays visible on the upstream PR.

```bash
cat > .generated/upstream-pr/terms.txt <<'TERMS'
acme
acme.example.com
123456789012
TERMS

test -s .generated/upstream-pr/terms.txt || echo "REFUSING: term list is empty"
grep -inFf .generated/upstream-pr/terms.txt .generated/upstream-pr/outgoing.txt \
  || echo "PASS: no identifier hits"
```

Replace the example terms with real ones. If the placeholders are left in, the grep matches
nothing and looks like a pass.

**3. Account for every binary.** A diff shows a binary as one line with no content, so the
identifier scan cannot see inside it. Screenshots, `sandbox/tools/<id>/<binary>`, state
snapshots, and PDFs all land here.

```bash
grep '^Binary files' .generated/upstream-pr/outgoing.txt || echo "PASS: no binaries"
```

Justify each hit individually or drop it from the branch.

**4. The surfaces git cannot see.** None of these appear in any diff:

- the branch name
- the PR title and description, including pasted error output or stack traces, which
  routinely carry internal hostnames, account IDs, and real user identifiers
- screenshots attached to the PR. This repository requires one for any change an operator
  or user sees rendered, and a screenshot of your instance shows your organization's data,
  channels, and people. Reproduce the surface against synthetic data and say that you did.
- reproduction steps that name an internal system, and test data derived from real records

The title and description also carry no provenance. Write them from upstream's point of
view and describe what the change does, never where it came from. That the change
originated in a private fork, was cherry-picked from other branches, passed your fork's
CI, or was prepared with this skill is process, not content, and naming your fork points
readers at a repository they cannot see. Mention private forks only when the fork model
itself is the subject of the change.

## Pushing from a private fork

A private fork is a standalone repository outside GitHub's fork network, so it cannot
open a cross-repo pull request.

If you have write access to upstream qm, push the topic branch there and open the PR inside
that repository:

```bash
git push upstream <topic>
gh pr create --repo yc-software/qm --base main --head <topic> \
  --title "<title>" --body-file .generated/upstream-pr/body.md
```

If you do not, keep a separate public GitHub fork of qm for contributions and push the
branch there from a different clone. Do not add that GitHub fork as a remote in the
private fork's clone, where a mistyped push target would send private history to a
public repository.

Always pass `--title` and `--body-file`; without them `gh` prompts, which fails in a
non-interactive run. Pass `--head` explicitly, because `gh` otherwise infers the head
repository from local remotes, and a private fork's `origin` is the private repository. For the
same reason, pass `--repo` to every `gh` command you run in a private fork: without it,
`gh pr edit 1` can silently overwrite PR #1 of the source repository. If that happens, the
prior body is recoverable through the GraphQL `userContentEdits` field.

After the PR merges, do not also commit the change to the private fork. It arrives through the
next `update-qm` sync, and committing it in both places guarantees a conflict.

## If something leaked

Say so immediately rather than quietly force-pushing. A deleted branch or amended commit
stays reachable by SHA on GitHub and in every clone. Rotate whatever was exposed
(credentials, tokens, URLs that act as capabilities) and tell whoever owns the affected
system. The disclosure is the fix; rewriting history is not.
