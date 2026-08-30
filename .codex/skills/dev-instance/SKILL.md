---
name: dev-instance
description: Run the current worktree as a production-shaped local dev instance — core, Slack, web UI, admin, portal, on a real Pi LLM + Postgres — reachable in Slack as your own bot. Each developer uses their own set of Slack apps from their own machine's pool store, so many worktrees (yours and a teammate's) can run reachable at once without colliding. Use when asked to /dev-instance, "spin this up so I can QA it in Slack", or "let me test your branch end to end".
---

# dev-instance

`dev-instance` runs the current worktree as a full, production-shaped stack on your
machine and makes it reachable in Slack as one of _your_ bots. It is the way to QA a
branch end to end: real LLM turns, a real sandbox, a real local Postgres (empty by
default; opt in to prod data), and the real Slack/web/admin surfaces.

Use the repo-root launcher (a thin wrapper over the TypeScript CLI in `scripts/dev/`;
every command accepts `--json` for machine-readable output):

```bash
bash scripts/dev-instance.sh up
bash scripts/dev-instance.sh status
bash scripts/dev-instance.sh down
bash scripts/dev-instance.sh doctor
bash scripts/dev-instance.sh canary
bash scripts/dev-instance.sh restart [child]
bash scripts/dev-instance.sh logs [child] [-f]
```

`npm run dev-instance`, `npm run dev-instance:status`, `npm run dev-instance:down`, and
`npm run dev-instance:doctor` are equivalent. The Codex-visible skill copy lives at
`.codex/skills/dev-instance/SKILL.md`; keep the two skill descriptions equivalent.

## What `up` Starts

`up` claims one free Slack app slot from **this machine's** pool store (see "Slack reach"
below), then spawns a **per-slot supervisor daemon** that owns the production-shaped stack:

- core API + workers
- Slack Socket Mode plugin (connected as the claimed app's bot)
- web UI surface
- admin surface
- portal front door proxying `/web-ui/` and `/admin/`

The supervisor restarts crashed children with backoff, waits for a port to actually free
before respawning (no more EADDRINUSE), health-probes everything every 10s, and writes a
heartbeat so slot reclaim can tell "actively in use" from "abandoned".

**`up` only prints success after proving the bot is reachable**: the Slack socket must be
the app's _only_ connection (`num_connections == 1`, read from the hello frame) and — when
the slot has a `CANARY_CHANNEL` — a posted canary message must arrive back over that same
socket. If another machine/worktree holds a connection to the app (the classic "boots LIVE
but deaf" failure), `up` detects it, flags the slot for 30 minutes, and auto-rotates to the
next one, reporting the thief's hello host. A canary that never returns on a clean socket
means a stale Slack app; `up` flags and rotates past that too.

**Re-running `up` on a live instance is a reload, not a no-op**: it re-reads your shell
env, dev.env, and `.env`, diffs against what the children are running, and does a rolling
restart + re-verification when anything changed (`--force` to restart regardless,
`--rotate` to move to a different Slack app).

Open the portal URL printed by the CLI. Direct web/admin URLs are also printed for
debugging, but the portal URL is the prod-like path.

## Sandbox: local Docker by default

The agent's `execute` sandbox runs as a **local Docker container** (`SANDBOX_BACKEND=local`)
when the worktree's code supports it — no cloud credential, no tunnel, no microVM cold
starts, and the sandbox reaches core's self-API at `host.docker.internal` directly. Build
the image once per machine with `npm run sandbox:local:build` (the CLI warns if it's
missing or stale). Use local Docker unless you are specifically testing the cloud path.

For prod-parity QA, pass `--sandbox <backend>` to run against your deployment's real
sandbox provider instead. That path validates the provider credential and opens a tunnel
so the remote sandbox can call back to your local core, so it needs whatever that provider
requires; the local backend needs nothing but Docker.

## Slack reach: your apps vs a teammate's

This is the part people get wrong, so it's worth stating plainly.

A Slack app's **Socket Mode** connection is single-owner: if two running instances point
at the _same_ app, Slack load-balances inbound messages between them and each instance
silently loses half. So the rule is **one live instance per Slack app**.

The way we keep out of each other's way is simple: **every developer has their own set of
Slack apps**, listed as `poolN.env` files in their **own machine's** pool store
(`~/.config/qm/slack-pool`). `up` claims the first free slot on _this_ machine and boots
that app's bot; the script prints its `@handle`. You QA by DMing that bot in
`example.slack.com`.

- **Your machine** (Alice's): the pool holds `pool1.env … pool10.env`, which are the apps
  `bot1 … bot10`. So up to 10 worktrees can run reachable at once here; each `up` grabs
  the next free slot, `down` frees it. DM whichever `@botN` the script printed.
- **A teammate's machine** (e.g. Carol's): a _different_ set of apps in _their_ local pool
  store. Their instances claim their apps; yours claim yours. You never collide, because you
  are never pointing at the same app — and there is no shared registry, no `#worktree`
  prefix, and no relay to coordinate. Each of you just DMs your own bot.

The per-machine pool lease (an atomic lock per slot) also stops two worktrees on the _same_
machine from grabbing the same slot. Before connecting, `up` sweeps the machine for
orphaned processes still holding the slot's Slack app token (e.g. a plugin another
worktree's teardown missed) and kills them. If every slot is taken, `up` reclaims one —
but **never a slot whose supervisor heartbeat is fresh**: an actively used instance can't
be stolen mid-QA; only dead/legacy leases fall back to the old not-today / 4-hour rule.

To add capacity, mint more Slack apps from `src/slack/manifest.json` (one Socket Mode
app each, with `connections:write` for the app-level token) and drop a `poolN.env`
containing `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`), and `HANDLE` into your
pool store. The boot canary picks its channel automatically: a channel named `dev-canary`
if the bot is in one, else a `ci-*` throwaway it is in — never a human channel — and the
canary message is deleted right after it round-trips. `CANARY_CHANNEL=<channel id>` in the
slot env overrides. With no eligible channel at all, `up` prints `delivery unverified` (or
fails under `--strict`).

A forgotten instance cleans itself up: after 8 hours with no Slack events and no CLI
actions the supervisor tears itself down and frees the slot
(`DEV_INSTANCE_IDLE_HOURS` overrides; `0` disables).

## Real by Default

The dev instance should exercise the real system:

- real LLM: needs a model credential for the harness you run. Core supports several
  (`HARNESS=pi|opencode|codex|claude`); the launcher picks one from the credentials it
  finds and honours an explicit `HARNESS`. Set the key your chosen harness expects. For
  Codex, a ChatGPT OAuth session is also supported: `HARNESS=codex` discovers a valid
  `$HOME/.codex/auth.json`, or you can set `CODEX_AUTH_FILE` to another auth file. Core
  refreshes OAuth tokens centrally and hands the Codex child ephemeral material (no
  refresh token). Pass `DEV_INSTANCE_ALLOW_MOCK=1` for a deliberate no-model wiring
  check. The auth-file path is for local dev instances; deployed production processes
  use an API key or a keychain credential (`CODEX_AUTH_CREDENTIAL` /
  `CLAUDE_AUTH_CREDENTIAL`), whose secret lives encrypted in its owner's keychain.
- real durability: uses `DATABASE_URL` when supplied; otherwise starts/reuses a local
  Docker Postgres container and runs core with `SESSION_STORE=postgres` and
  `RUN_STORE=postgres`
- production data is never copied into a dev instance
- captured model context: request capture is on unless overridden, so you can read back what the model was actually sent
- fast local edits: runs Node surfaces with `--watch` and serves the web UI through
  Vite HMR on the dev surface instead of a separate browser build loop
- stale pool recovery: `status` shows each deploy's start time and age; if all pool
  apps are taken, `up` reclaims a slot not started today or older than 4 hours
- local admin seed: for a self-provisioned local DB, empty `admin_grants` are seeded
  from `DEV_INSTANCE_ADMIN_PRINCIPAL` or the local OS user; explicit `ADMIN_GRANTS`
  still wins
- local portal auth: the launcher sets a localhost-only portal auth bypass, signing in
  as `DEV_INSTANCE_ADMIN_PRINCIPAL`, the first `ADMIN_GRANTS` principal, the first
  durable `org_admin` in Postgres, or the local OS user. Production portal auth remains
  real OIDC.

Only use escape hatches for deliberate wiring checks — this is how you ask for _less_ than
the full real stack when a test doesn't need it:

```bash
DEV_INSTANCE_ALLOW_MOCK=1 bash scripts/dev-instance.sh up
DEV_INSTANCE_ALLOW_MEMORY=1 bash scripts/dev-instance.sh up
DEV_INSTANCE_WATCH=0 bash scripts/dev-instance.sh up
DEV_INSTANCE_RECLAIM_STALE=0 bash scripts/dev-instance.sh up
```

## Env Discovery

The launcher reads values from, in priority order: exported shell env, the machine-global
`~/.config/qm/dev.env`, your login shell (for a model credential exported there), and this
worktree's `.env` (seeded from the main checkout in linked worktrees). Slack pool tokens
default to `~/.config/qm/slack-pool`.

When a cloud sandbox backend is configured it also validates that provider's access at
startup, refreshes a stale provider token from the provider CLI's own logged-in session
where it can, and — if a tunnel binary is present — opens a quick tunnel so sandbox
self-API calls can reach your local core. None of that runs on the default local backend.

## After Startup

Report the slot, portal URL, Slack handle, and log directory. To test Slack-specific
behavior, DM the printed `@<handle>` (on Alice's machine that's one of `@bot1 … @bot10`)
in `example.slack.com`; for admin and web behavior, open the printed portal URL. Tear down
with `bash scripts/dev-instance.sh down` when QA is finished.

## Troubleshooting

**Start with `dev doctor` (or `doctor --json`).** It runs the checks that used to take a
debugging session by hand — socket exclusivity (`num_connections`), a live canary
round trip, env/git drift since boot, per-child health and restart counts, stale leases,
port squatters, machine-wide token orphans, Docker daemon — and prints a ranked diagnosis
with a remedy per finding. `doctor --fix` applies the safe ones (child restarts).

**Bot never replies to a DM (silent bot).** The new `up` catches the two big causes at
boot: another live connection to the same app (auto-rotates, names the thief's host) and a
stale Slack app whose events never arrive (canary fails → flags the slot and rotates). If
deafness appears mid-session, the 10s health probe logs `DEGRADED: num_connections=N` in
`supervisor.log` and the periodic canary flags delivery loss; `dev canary` gives you an
on-demand proof either way. `dev up --rotate` moves to a fresh slot.

For a slot flagged `canary-failed`, the app itself is stale and needs rebuilding (~5 min):
at api.slack.com **signed into the example workspace** (the dev console is
per-workspace-identity — use "Sign in to another workspace" if it lists the wrong one):
Create New App → From a manifest → paste `src/slack/manifest.json` (give it a unique
`name` and bot `display_name`; old handles stay taken) → Install to Workspace → Basic
Information → App-Level Tokens → Generate with the `connections:write` scope. Write the Bot
token (`xoxb-…`) and app-level token (`xapp-…`) into `poolN.env`, delete `poolN.flag.json`,
then run `up` again. (If you own the existing app, just reinstalling it also works.)

Two smaller gotchas: a freshly-created bot isn't in Slack's "New message" people search for a
minute or two — open its DM deterministically via `conversations.open` (bot token + your user
id) and navigate to `app.slack.com/client/<team-id>/<D-channel-id>`. And the browser's Slack
login drops easily during long automated sessions; re-authenticating is a Google SSO you have
to complete yourself.
