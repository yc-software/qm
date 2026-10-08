# E2B as a selectable agent-computer backend

Ondrej from E2B here. qm core already has an E2B backend (`SANDBOX_BACKEND=e2b`), but an operator can only reach it by setting `env.core.SANDBOX_BACKEND` by hand, because the CLI config rejects `"sandbox.backend": "e2b"`. And the image you get from `npm run build:e2b-template` is thin: no gh, no AWS CLI, no Claude Code or Codex. So we did the E2B side and this PR does the small qm side.

What E2B published

- `qm-sandbox`, a public agent-computer template. Same tools as your sandbox base image (`fly/Dockerfile`): Claude Code, Codex, gh, AWS CLI, the venv at `/opt/agent-venv`, x-api. 8 vCPU and 8 GiB where the plan allows, runs as `user` in `/home/user/workspace` like the backend expects. Tagged releases, so a deployment can pin one.
- `qm-core`, for small teams and trials that want everything on E2B. `e2b sandbox create qm` starts core with a setup page, and the scopes run on `qm-sandbox`. It is not a replacement for the Fly or AWS targets.

What this PR changes

- `"sandbox.backend": "e2b"` in the CLI, on every target, the same way agent37 is wired: type, allowlist, validation, forwarding `SANDBOX_BACKEND` to core, and the stray Fly settings check. One test, modeled on the agent37 one.
- `docs/e2b-template.md` starts with the public template and the one-hour-plan setting below. Building your own image stays documented.

What it does not change

- No backend code. The E2B profile still lists gh and aws as not installed. That is right for `qm-base` and wrong for `qm-sandbox`. Two ways to fix it: bring `deploy/e2b/e2b.Dockerfile` up to the base image and drop them from the list, or probe the sandbox once at provision. Until then, a deployment layer that advertises gh and aws takes them off the list.
- No default changes.

One thing operators hit: core asks E2B for a 61 minute timeout (its one-hour command cap plus a minute). Plans capped at one hour reject every create with `400: Timeout cannot be greater than 1 hours`. `E2B_MAX_LIFETIME_SEC=3600` fixes it and caps a command at 59 minutes. It is in the docs now.

If you would rather take only this file and do the code yourselves, as CONTRIBUTING suggests, say so and I will trim the PR.
