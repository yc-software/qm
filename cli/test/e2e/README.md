# `qm` CLI end-to-end tests

These drive the **real** `qm` binary as a subprocess and verify each command's
_objective_ — files actually scaffolded, containers actually running, the right `flyctl`
actually issued, the deployment actually torn down — not just that something was printed.

```bash
cd cli
npm run test:e2e
npm run test:all
npm test
```

They load the repo's `./.env` into the child environment (so `ANTHROPIC_API_KEY` /
`CORE_SIGNING_SECRET` / `SKILL_SIGNING_SECRET` are present, as an operator's shell would have them).

## What each file covers

| file               | command(s)                                                                              | how it's real                                              |
| ------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `meta`             | `help` · `version` · unknown cmd                                                        | exit codes + stream routing through the shipped bin        |
| `init`             | `init` (+ `--org`/`--target`, clobber refusal)                                          | scaffolds, then **round-trips through `check`**            |
| `check`            | `check` (+ `--sandbox-dir`)                                                             | pass on a valid layer; exit 1 naming each break            |
| `plan`             | `plan` = `up --dry-run` (docker) (+ `--build-from`/`--config`/`--sandbox-dir`/basePort) | asserts the resolved plan; verifies it starts nothing      |
| `sandbox-build`    | `sandbox build --dry-run` (+ `--from`/`--app`/`--tag`)                                  | asserts the generated Dockerfile + push command            |
| `docker-lifecycle` | `up`→`status`→`logs`→`down`/`--purge`                                                   | **real Docker daemon**, asserts against docker's own state |
| `identity`         | `init`→`check`→`slack render`→`outputs` with a custom `botName`                         | brands the real manifest; outputs rejects a stale one      |
| `fly`              | `plan`/`status`/`logs`/`down`/`--target`/`--only`/`-f` (fly)                            | a **fake flyctl** records the exact commands issued        |
| `dev`              | `dev status`/`down`/`logs`/`up` precondition                                            | isolated pool store; never touches the real pool           |

## Design notes

- **Docker lifecycle uses stand-in images.** The CLI's job is to _provision and supervise_
  services, so the test builds tiny `alpine` stand-ins (they echo every service's readiness
  line then idle) via `up --build-from <fake checkout>`. That exercises the full
  build → run → wire → wait-readiness → status → logs → teardown path without depending on
  the heavyweight (and not-yet-published) service images. Skips when no daemon is reachable.
- **Fly is never really deployed.** A fake `flyctl` (`FLY_BIN`) answers the read/list verbs and
  logs every invocation; real Fly deploys are outward-facing and create apps.
- **Isolation.** Every deployment uses a unique org `qm-e2e-<label>-<pid>` (so it never collides
  with a real `acme` stack); dev tests set `QM_POOL_STORE` to a temp dir. Everything is
  torn down in `finally`/`after`.

## Note: `--env-file` and node's same-named flag

Node (≥24, incl. the repo's pinned 24.13.0) treats `--env-file` as its **own** flag and pre-scans
the whole command line for it — even after the script — so a naive `node bin/qm.ts … --env-file X`
lets node hijack the flag before the CLI runs (loading it into node's env, or exiting on a missing
file). The bin's shebang therefore ends node's option parsing with `--` (`#!/usr/bin/env -S node --`),
so the user's `--env-file` reaches the CLI. `runCli` mirrors that by spawning `node -- <bin> …`, and
the `plan --env-file` e2e guards it (it would exit 9 with node's error, not 1 with the CLI's, if the
shield regressed).
