# E2B as a selectable agent-computer backend

Ondrej from E2B here. qm core already has an E2B backend (`SANDBOX_BACKEND=e2b`), but an operator can only reach it by setting `env.core.SANDBOX_BACKEND` by hand, because `qm init` rejects `"sandbox.backend": "e2b"`. And the image you get from `npm run build:e2b-template` is thin: no gh, no AWS CLI, no Claude Code or Codex. So we did the E2B side and this PR does the small qm side.

What E2B published

- `e2b/qm-sandbox`, a public agent-computer template. Same tools and pinned versions as your sandbox base image (`fly/Dockerfile`): Claude Code, Codex, gh, AWS CLI, the venv at `/opt/agent-venv`, x-api. 8 vCPU, 8 GiB, runs as `user` in `/home/user/workspace` like the backend expects. Tagged releases, so a deployment can pin one.
- `e2b/qm-core`, for small teams and trials that want everything on E2B. It runs your docker target unchanged inside one long-lived sandbox, with `qm-sandbox` for the scopes. It needs a plan with a 24 hour timeout, and since a paused box cannot receive Slack Socket Mode events, it has to be paused and resumed once a day. We say that in its README; it is not a replacement for the Fly or AWS targets.

Both live in https://github.com/e2b-dev/customer-starter-templates.

What this PR changes

- `"sandbox.backend": "e2b"` in the CLI, on every target, the same way agent37 is wired: type, allowlist, validation, forwarding `SANDBOX_BACKEND` to core, and the stray Fly settings check. One test, modeled on the agent37 one.
- `docs/e2b-template.md` starts with the public template and the one-hour-plan setting below. Building your own image stays documented.

What it does not change

- No backend code. The E2B profile still lists gh and aws as not installed. That is right for `qm-base` and wrong for `qm-sandbox`. Two ways to fix it: bring `deploy/e2b/e2b.Dockerfile` up to the base image and drop them from the list, or probe the sandbox once at provision. Your call; we can do either.
- No default changes.

One thing operators hit: core asks E2B for a timeout a bit over one hour. Plans capped at one hour reject every create with `400: Timeout cannot be greater than 1 hours`, and the agent only sees a timeout. `E2B_MAX_LIFETIME_SEC=3600` fixes it. It is in the docs now.

If you would rather take only this file and do the code yourselves, as CONTRIBUTING suggests, say so and I will trim the PR. E2B keeps `qm-sandbox` in step with your base image when you bump versions.
