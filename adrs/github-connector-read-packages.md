# GitHub connector scopes: add read:packages

The GitHub OAuth connector asks for `repo` and `read:org` (src/connectors/oauth.ts). That covers
the git and REST work, but it misses one thing that comes up constantly: installing dependencies.

We hit this today. An agent opened a PR on one of our repos and then couldn't run typecheck or
tests, because `pnpm install` pulls a private package from GitHub Packages and got a 401. The
token it had is fine for cloning the repo and pushing the branch. It just can't read the
registry. So the agent pushed the branch and said "CI will have to verify this," which is a
worse outcome than it needed to be.

Any org that keeps private packages in GitHub Packages will hit the same wall, and it's invisible
until an install fails halfway through a task. Adding `read:packages` to that scopes array fixes
it. It's read-only and it doesn't widen anything a `repo` token can't already reach.

We're unsure on a couple of points and would defer to you:

- Existing connections keep their old scopes until the user reconnects, so people would need a
  re-consent to pick this up. Worth a nudge in the UI, or fine to let it happen naturally?
- If you'd rather not add a scope everyone pays for, the alternative is making the scope list
  configurable per deployment. That's more work and more surface area, and we'd rather just have
  the scope.

Happy to send the change if you want it.
