# E2B as a selectable agent-computer backend

Drew from E2B here. This PR lets an operator pick E2B for agent computers with `"sandbox.backend": "e2b"`, the same way #922 did for Agent37.

Core already has the E2B backend (`SANDBOX_BACKEND=e2b`). The CLI was the missing piece: its config rejects `"sandbox.backend": "e2b"`, so the only way in is setting `env.core.SANDBOX_BACKEND` by hand. The image from `npm run build:e2b-template` is also thin, with no gh, AWS CLI, Claude Code or Codex.

So E2B now publishes two public templates in all three regions (US, EU, APAC), by bare name:

- `qm-sandbox`, the per-scope agent computer. Same tools as your sandbox base image (`fly/Dockerfile`), 8 vCPU and 8 GiB, runs as `user` in `/home/user/workspace`.
- `qm-core`, core on E2B for small teams and trials. `e2b sandbox create qm` starts it with a setup page. It does not replace the Fly or AWS targets.

What the PR adds

- `"sandbox.backend": "e2b"` in the CLI, wired like agent37: type, allowlist on docker, fly and aws, validation message, forwarding `SANDBOX_BACKEND` to core, and the stray Fly settings check. One test, modeled on the agent37 one. The CLI suite passes on Node 24 (624/624).
- `docs/e2b-template.md` now starts with `qm-sandbox:v1.0.0` and the one-hour plan setting.

Backend and default changes

Live use of E2B as the only cloud showed gaps the CLI change alone leaves. Each change and why:

- `DEPLOY_PROVIDER=e2b`: published apps run in their own E2B sandbox, paused when idle and resumed by the next request, so an E2B-only deployment needs no second cloud for apps. It reuses `E2B_API_KEY` and `E2B_TEMPLATE_ID` and the shared app launcher.
- Making an app public is refused (409) unless an apps domain and gate secret are set, on both the share route and the agent's apps tool. Before, it reported "anyone with the link" while signed-out visitors still got 401. `e2b.app` joins the shared domains refused as an apps domain.
- The E2B profile lists gh, aws and x-api as installed only when `E2B_TEMPLATE_ID` is set, since E2B's stock image has none of them. The template now copies in `x-api`.

One thing operators hit: core asks E2B for a 61 minute timeout, so plans capped at one hour reject every create. `SANDBOX_MAX_LIFETIME_SEC=3600` fixes it, and the docs say so.

If you would rather take only this file and do the code yourselves, say so and I will trim the PR.
