# Fly sandbox

Per-scope **Firecracker microVMs** as the agent sandbox.
Stronger isolation than a container (separate kernel) and the machine **persists**
between turns, so installed packages / venv / build state stay warm — a private
"laptop" per scope. The core's `FlySandbox` (`src/sandbox/fly-sandbox.ts`) drives
machines over the [Fly Machines API](https://fly.io/docs/machines/api/). The VM disk
is the writable source of truth for this backend: the **read-only** mount layers
(org/team/granted scopes) are materialized into it from their owners' stores each turn,
while the **writable** layer lives on the persistent disk and is never re-seeded from
the store (cold-start recovery is `backupComputer`'s object-store backup). `snapshotWritable`
remains intentionally a no-op because the legacy per-turn workspace snapshot is the wrong
abstraction for a resident computer.

Because the snapshot is a no-op, the `write` primitive **dual-writes** each explicit write
to the durable workspace store (gated by the orchestrator's `persistWritesToStore`). A
cross-scope grant resolves a shared file from the **owner's** store, so without this an
agent-written file would be invisible to a grantee — "share this redline with Angela"
would silently fail. Transient spools (inbox/outbox/skills) and read-only mounts stay
VM-only.

The base image is a Debian (glibc) + Node image (see `fly/Dockerfile`), with AWS CLI v2
baked in; glibc means vendor install scripts and prebuilt binaries (AWS CLI v2, gcloud,
kubectl, gh) work as they do on a typical laptop, without musl compatibility shims. The
agent installs whatever else it needs on the resident disk, the way a colleague would.

## When to use which sandbox

- **docker** (default) — container, **open egress** (default bridge). Local dev + most prod.
- **local** — host `child_process`, fast, **not isolated**. Dev/tests only.
- **fly** — persistent microVM, warm state. **Open egress.**

## Agent Computer profile

Fly declares the first resident-auth Agent Computer profile:

- `isolation=microvm`
- `lifetime=per_scope`
- `writablePersistence=resident_disk`
- `homePersistence=resident_disk`
- `egress=provider_governed`
- `auth=resident_machine`

Docker/local remain per-turn sandboxes that snapshot writable files back to the
workspace store and do not support resident machine auth.

## Durable `$HOME` volume & auto-upgrade

Each scope's `$HOME` (`/root`) is a **per-scope Fly volume** (`home_<scope>`, sized by
`FLY_VOLUME_GB`, default 3 GiB), created on first provision and mounted into the machine.
This separates two lifecycles that used to be fused in one rootfs:

- **Durable agent state** (resident creds and anything written under `$HOME`) lives on the
  volume and survives a rootfs swap — like a laptop's home dir surviving an OS upgrade.
- **The rootfs** (OS + baked tools like `browse` and any deployment-layer CLIs, plus the baked Python venv at
  `/opt/agent-venv`) can be replaced freely. (`pip install`s land in that venv, so they reset
  on an image recreate — an accepted, rare cost.)

So a new base image rolls out **without a manual `fly machine destroy`**. Core receives the
target image as `FLY_BASE_IMAGE`, which `qm sandbox publish` pins by digest. On a scope's next
provision, `FlySandbox.ensureMachine` compares the machine's own image reference to the target
and, if they differ, recreates the machine **keeping its volume** (`coldStart=false`, home
intact — no restore needed). A machine that predates volumes (no `/root` mount) is
migrated once: it's recreated with a fresh volume as a cold start, so the orchestrator
restores the object-store backup into it. Because that backup **excludes `~/.aws`** (see
below), the agent re-auths (`aws sso login`) once after the legacy migration.

The Python venv is **baked into the rootfs at `/opt/agent-venv`** (on PATH), so it's present
the instant the machine boots — no per-scope bootstrap. It lives at `/opt`, not `/root`,
because `/root` is the per-scope volume mount that would SHADOW anything baked under it. This
removes the old first-provision `python -m venv` + network pip step (~5-15s on every cold
start) and keeps the venv off the home-volume backup. Trade-off: `pip install`s land in the
rootfs venv, so they reset when a scope's machine is recreated (image-version bump / reap).

## Backup exclusions

Fly's Agent Computer backup follows the Hermes S3-sync lesson: it excludes `.aws/*`
so stale AWS credential caches cannot shadow the platform role after restore. It also
excludes reproducible/noisy runtime caches (`__pycache__`, `.cache`, and any user-created
`~/venv`) that can make a resident-home export too large for provider APIs. (The agent's own
Python venv now lives in the rootfs at `/opt/agent-venv`, so it isn't in the home backup at all.)
Resident tool caches (a CLI's `~/.<tool>/` state) can be backed up. Export/import is
batched as one tar stream per area (`workspace`, `home`) instead of one Fly Machines
API exec per file, which keeps backup viable after the agent creates many files. The
backup is durable **by default**: it is written to S3 when `SNAPSHOT_STORE=s3` is
configured (cross-machine), otherwise to the core's local persistent volume
(`$DATA_DIR/blobs`, single-machine durable) — it is never left un-persisted, because it
is the only durable record of agent files on this backend (the VM disk is canonical and
`snapshotWritable` is a no-op, so the workspace-store never sees them). The orchestrator
restores a backup only onto a freshly-created persistent computer, then writes a new
backup after the turn; warm VMs are left as the source of truth to avoid clobbering newer
resident disk state with an older snapshot. This backup also powers the admin **files**
view (`GET /v1/admin/files`), which reads it so agent-written files appear in the
dashboard even though they live on the VM, not in the workspace-store.

## Turn env

Fly drops host-proxy routing env (`http_proxy`, `HTTPS_PROXY`, etc.) when proxy routing is
not configured. It keeps other non-secret turn env (e.g. connector `VAULT_TOKEN_<HOST>`
materialized for the acting user). Resident CLIs authenticate as the
box's resident machine identity — no acting-user claim is injected.

## Egress

Dangerous posture permits direct outbound network access. Auto forces traffic through the
audited proxy and blocks private/metadata destinations unless the admin explicitly allows a
host. Strict does not provision a sandbox. Configure the proxy as described in the deployment
guide before using Auto on Fly.

## Build & deploy the base image (once)

```bash
brew install flyctl
fly auth login
export FLY_SANDBOX_APP_NAME=<operator-owned-sandbox-app>
fly apps create "$FLY_SANDBOX_APP_NAME" --org <fly-org>
npm run deploy:fly-image
```

The base image keeps a minimal generic toolset (the coding-agent CLIs and AWS CLI v2;
the optional agentic browser engine is build-gated in `fly/Dockerfile`).
Deployment-specific tools are NOT baked here — a deployment stacks them on top via its
sandbox layer (`qm sandbox build` over `<deploy dir>/sandbox/`). Anything else the agent needs is installed on the
**resident disk** of the persistent microVM, which survives across turns: optional CLIs
such as `glab` or X tooling are installed residently the first time they're needed,
exactly as on a real laptop.

Use `npm run deploy:fly-image` rather than bare `fly deploy`: this sandbox app is
exec-only, and bare deploy creates default launch machines that are not used by
`FlySandbox`.

Sandbox machines run `linux/amd64` only. `npm run deploy:fly-image` builds on Fly's
remote amd64 builder, so it works unchanged from arm64 (Apple Silicon) hosts, where a
local `docker build` produces an arm64 image the machines reject and
`--platform linux/amd64` under qemu emulation is slow and unreliable.
`scripts/local-sandbox-build.sh` follows the same rule: it uses the remote builder when
`FLY_SANDBOX_APP_NAME` is set and otherwise builds locally with
`--platform linux/amd64`.

## Configure the core

```bash
FLY_API_TOKEN="$(fly tokens create deploy -a "$FLY_SANDBOX_APP_NAME")" \
FLY_SANDBOX_APP_NAME="$FLY_SANDBOX_APP_NAME" \
FLY_BASE_IMAGE="registry.fly.io/$FLY_SANDBOX_APP_NAME@sha256:<digest>" \
FLY_REGION=sjc \
npm start
```

Other knobs: `FLY_CPU_KIND` (shared), `FLY_CPUS` (1), `FLY_MEMORY_MB` (512),
`FLY_AUTO_SUSPEND` (1 — suspend after each turn; ~½s resume), `SANDBOX_TIMEOUT_SEC`
(120 — the sandbox's bare per-command backstop; reached only on a standalone/misconfigured
path, since the orchestrator now always passes an explicit per-command timeout).

**Per-command execute timeout.** Each `execute` command has a wall-clock cap (exit 124 on
kill). The agent sets it per command via the tool's `timeout_seconds` param; if it doesn't, the
command falls to the configured default. Knobs (orchestrator → tool context):
`EXEC_TIMEOUT_DEFAULT_SEC` (120 — covers an unanticipated moderately-long command:
npm install / tsc / a test run) and `EXEC_TIMEOUT_MAX_SEC` (300 — the hard ceiling the agent's
`timeout_seconds` is clamped to, so one session can't starve others; work beyond it should use
background execution / be broken into shorter steps). Resolution order: agent param > default >
sandbox backstop.

> **Running the core itself ON Fly?** Fly injects `FLY_APP_NAME` at runtime as the
> _core's own_ app name, which would clobber the sandbox target. Set
> `FLY_SANDBOX_APP_NAME=<sandbox app>` instead (wiring prefers it; see `src/wiring.ts`).
> `FLY_REGION` is likewise injected by Fly, so you can omit it on-Fly.
> Machines are named by scope (`personal-u1`, …); a scope reuses its machine across turns.

Resident machine auth env is installed only when a Fly machine is first created. Set
new-machine env with the explicit `FLY_RESIDENT_ENV_` prefix, for example
`FLY_RESIDENT_ENV_AWS_ACCESS_KEY_ID`, `FLY_RESIDENT_ENV_AWS_SECRET_ACCESS_KEY`,
`FLY_RESIDENT_ENV_AWS_SESSION_TOKEN`, and `FLY_RESIDENT_ENV_AWS_DEFAULT_REGION`.
These are machine credentials for native CLIs such as `aws`, not egress proxy tokens.
For resident X tooling use the same prefix for native tool env, for example
`FLY_RESIDENT_ENV_X_BEARER_TOKEN` for `x-api`.

## Smoke test

```bash
FLY_API_TOKEN="$(fly tokens create deploy -a "$FLY_SANDBOX_APP_NAME")" npm run smoke:fly
```

For image-resident X helper readiness:

```bash
FLY_API_TOKEN=... npm run smoke:x
```

This verifies `x-api` is on PATH and reports `missing_auth=auth_missing` when no
resident X token is installed. Add `X_SMOKE_REQUIRE_AUTH=1` after configuring
`X_BEARER_TOKEN` / `X_ACCESS_TOKEN`, or `X_SMOKE_REQUIRE_FIREHOSE=1` when a vendored
`x-firehose` binary should be present.

The smoke test uses a timestamped personal smoke-test scope, writes
workspace and resident-home state, backs it up, deletes the Fly machine, recreates it,
restores the backup, verifies `.aws/*` stayed excluded, then deletes the smoke
machine. Add `SNAPSHOT_STORE=s3 S3_BUCKET=...` to exercise the real S3 object store;
without those vars it uses the same backup-store code over an in-memory blob store.

For GitHub/GitLab resident CLI readiness:

```bash
FLY_API_TOKEN=... npm run smoke:git-cli
```

This verifies `git` and `gh` are on PATH in a resident Fly computer and reports
whether `glab` is available. It also runs `gh auth status` and reports a sanitized
status (`ok`, `auth_missing`, `host_unreachable`, or `auth_error`) without printing
command output. If `glab` is available or required, it does the same for
`glab auth status`; otherwise GitLab auth is reported as `skipped`. Add
`GIT_CLI_SMOKE_REQUIRE_GLAB=1` when GitLab is meant to be supported by the current
image, `GIT_CLI_SMOKE_REQUIRE_GH_AUTH=1` after running `gh auth login` on the
resident computer, or `GIT_CLI_SMOKE_REQUIRE_GLAB_AUTH=1` after `glab auth login`.
A synthetic actor is destroyed by default; set
`GIT_CLI_SMOKE_ACTOR_ID=<real actor>` when testing an existing resident computer.
