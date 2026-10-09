# E2B as a selectable agent-computer backend

Drew from E2B here. This PR lets an operator pick E2B for agent computers with `"sandbox.backend": "e2b"`, the same way #922 did for Agent37.

Core already has the E2B backend (`SANDBOX_BACKEND=e2b`). The CLI was the missing piece: its config rejects `"sandbox.backend": "e2b"`, so the only way in is setting `env.core.SANDBOX_BACKEND` by hand. The image from `npm run build:e2b-template` is also thin, with no gh, AWS CLI, Claude Code or Codex.

So E2B now publishes two public templates in all three regions (US, EU, APAC), by bare name:

- `qm-sandbox`, the per-scope agent computer. Same tools as your sandbox base image (`fly/Dockerfile`), 8 vCPU and 8 GiB, runs as `user` in `/home/user/workspace`.
- `qm-core`, core on E2B for small teams and trials. `e2b sandbox create qm` starts it with a setup page. It does not replace the Fly or AWS targets.

What the PR adds

- `"sandbox.backend": "e2b"` in the CLI, wired like agent37: type, allowlist on docker, fly and aws, validation message, forwarding `SANDBOX_BACKEND` to core, and the stray Fly settings check. One test, modeled on the agent37 one. The CLI suite passes on Node 24 (624/624).
- `docs/e2b-template.md` now starts with `qm-sandbox:v1.0.0` and the one-hour plan setting.

What it does not do

- No backend code and no default changes.
- The E2B profile still lists gh and aws as not installed, which is wrong for `qm-sandbox`. A deployment layer that advertises them takes them off the list.

One thing operators hit: core asks E2B for a 61 minute timeout, so plans capped at one hour reject every create. `E2B_MAX_LIFETIME_SEC=3600` fixes it, and the docs say so.

If you would rather take only this file and do the code yourselves, say so and I will trim the PR.
