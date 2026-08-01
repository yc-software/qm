# Enforce the dependency cooldown during CLI bootstrap

Saw #42 and traced the bootstrap path to see if the cooldown actually applies. It doesn't.

The project's `.npmrc` sets `min-release-age=7`, which tells npm to reject packages published less than seven days ago. But that file lives in the qm source repo root. When a user runs the documented bootstrap command — `npm exec --yes --package=@yc-software/qm@latest -- qm init .` — that runs in their empty deployment directory, which has no `.npmrc`. The qm repo's cooldown is never consulted.

`qm init` then writes the resolved version into `package.json` as an exact dependency (around line 209 of `cli/src/commands/init.ts`), and the subsequent `npm install` locks it — still with no `.npmrc` in the directory, so no age gate on what gets installed.

The scaffolding in `init.ts` and `provider-scaffold.ts` writes `qm.config.jsonc`, `package.json`, `.env.example`, `.gitignore`, `AGENTS.md`, and provider-specific files — but never an `.npmrc`. So even after init, the deployment repo has no cooldown protection for any future `npm install` or `npm update`.

I'm not sure whether the fix is just scaffolding an `.npmrc` with `min-release-age=7`, or whether the bootstrap npm exec itself needs a flag or wrapper to enforce the age check on its own resolution of `@latest`. The second one seems harder since you don't control the user's global npm config. But you'd know better whether there's a mechanism for that.

Happy to help test whichever approach you go with.
