# Live Slack E2E (example)

Post-merge live scenarios against example.slack.com. The workflow
(`.github/workflows/live-e2e.yml`) boots the merged commit as a real instance on the GHA
runner — core (`SESSION_STORE=memory`) + Slack plugin in Socket Mode on a **CI-reserved
pool app** (`qm dev --ci`) — then `run.ts` drives the catalog in
`scenarios.ts` posting as a real example **user** (the "QA Human" account), so every
message takes the exact path a teammate's would: classification, lazy directory push,
threads, streaming `chat.update` edits.

## Layout

- `run.ts` — runner: lane scheduling (parallel lane fans out, the DM lane is serial
  because a DM is one session — `dm:<channel>` in src/slack), one retry (retried
  pass = _flaky_, still green), results + failing-session transcript dumps to `out/`.
- `scenarios.ts` — the catalog. Prompts embed `ctx.marker()` (an
  `ci-<runId>-<scenario>` token) so assertions grep for unforgeable strings and
  teardown can sweep crons/channels by marker.
- `harness.ts` — per-scenario `Ctx` (fresh channels, final-reply detection, LLM judge).
- `slack.ts` / `core.ts` — fetch-based Slack Web API + source-auth-signed core admin
  clients (transcripts via `/v1/admin/sessions`, crons via `/v1/admin/crons`).

A bot reply is **final** when its text is not a live-status frame (`⚙ Working… 12s`,
`⏳ Waiting…`, `💭 …`, trailing `▌` streaming cursor — see `src/slack/status.ts`)
and has stopped changing for 5s.

## Run locally

Bring up a dev instance (`/dev-instance up`) or `node cli/bin/qm.ts dev --ci up`, then:

```sh
SLACK_QA_USER_TOKEN=xoxp-… SLACK_BOT_TOKEN=xoxb-… \
CORE_API_URL=http://localhost:8181 CORE_SIGNING_SECRET=… ANTHROPIC_API_KEY=… \
LIVE_E2E_FILTER=@smoke node test/live-slack/run.ts
```

`LIVE_E2E_FILTER` takes a name substring, `@tag`, or `all` (`@smoke` = the two-scenario
subset; `sandbox`-tagged scenarios are auto-skipped unless `SPRITES_TOKEN` is set).
`LIVE_E2E_SHARD=n/m` splits the selected catalog deterministically for a CI matrix.
Set `LIVE_E2E_OBSERVATIONAL=1` to report completed catalog failures (and alert when
configured) without a nonzero exit; runner, setup, event-pump, and required-alert failures
remain blocking.

## Arga twin backend (no shared test workspace, no pool app, fully parallel)

With an Arga API key the same catalog runs against an **isolated Slack digital-twin
workspace** ([docs.argalabs.com](https://docs.argalabs.com)) instead of a shared test workspace: its own bot,
QA user, and minted `alice`/`bob`/`carol` actors per run — no shared workspace, no slot
serialization, no hand-provisioned accounts, and no Slack rate budget shared across shards.
The `twin-e2e` matrix job in the workflow provisions one twin per shard.

Mechanics: `arga-provision.ts up` provisions the twin, seeds users/tokens
(`arga.ts:seedTwinUsers`), pre-creates the reach target channel, and emits the boot env —
`SLACK_API_URL` (the plugin's Web API seam), `SLACK_EVENTS_MODE=http` +
`SLACK_SIGNING_SECRET` (the plugin listens for signed Events-API POSTs instead of Socket
Mode, which the twin doesn't speak), and the minted QA/actor tokens. `run.ts` then starts
an **event pump** (`arga.ts:startEventPump`) that polls the twin's `/admin/events` log and
delivers each recorded event — signed, per-channel FIFO — to the instance's receiver. The
pump also papers over two twin fidelity gaps: it stamps the missing `channel_type` and
synthesizes the `app_mention` twin of a bot-mentioning `message` event (real Slack sends
both; the plugin only dispatches channel mentions from `app_mention`).

Run locally (Free-tier keys cap the twin at 10 minutes — enough for `@smoke`):

```sh
export ARGA_API_KEY=arga_sk_…
eval "$(node test/live-slack/arga-provision.ts up | grep '^export ')"
node cli/bin/qm.ts dev --ci up
LIVE_E2E_FILTER=@smoke node test/live-slack/run.ts
node cli/bin/qm.ts dev --ci down; node test/live-slack/arga-provision.ts down
```

Twin-only scenarios (`scenarios-twin.ts`, tag `@twin`) exercise what a live workspace
can't: event redelivery (dedupe/idempotency), mid-session scope revocation, and per-method
rate limiting. Scenarios that mutate workspace-global twin config use the `exclusive` lane
(run alone, after the other lanes) and restore what they touched.

## Tiers, triggers, quarantine

- **Tiers via tags.** `@core` is the fast high-signal subset run on every push to main;
  the full catalog (`all`) runs on PR-label + on-demand. `@multiuser` = the multi-user
  channel scenarios; `@sandbox` = needs Fly; `@smoke` = the tiny two-scenario subset.
  Capability tags gate _where_ a scenario can run: `twin` needs a twin backend, and
  `no-twin` is its inverse — a capability the twin cannot serve, skipped on twin runs
  (with the reason) so it can't produce a red that says nothing about the product.
- **Triggers.** push→main runs `@core`; add the **`live-e2e` label** to a PR to run the
  full catalog against that branch; `workflow_dispatch` takes a `filter` + a `slot` (1–3)
  so an on-demand feature-push run doesn't queue behind main's. Slots 2/3 need
  `LIVE_E2E_SLACK_{BOT,APP}_TOKEN_{2,3}` secrets (extra CI apps); slot 1 uses the existing pair.
- **Quarantine.** tag a known-flaky scenario `quarantine`: it still runs and shows in the
  gallery/summary (with a chip), but never counts toward the pass/fail signal (exit code +
  `#ci-alerts`) while it's being stabilized. "Don't accept flaky" — fix or quarantine, don't
  let a red scenario erode trust in the suite.

**Rollout state:** CI is required. Catalog failures alert `#ci-alerts` and fail the job; twin
failures alert through the real CI Slack app. Observational mode is available only for explicit
local runner invocations; the GitHub workflow does not enable it.

**Growing the catalog:** `scripts/mine-slack-scenarios.ts` reads a core Postgres, clusters
recent _multi-user channel_ sessions by shape, and emits a digest to hand-author new
scenarios from (curation over an auto-compiler, on purpose). Run it in the core box (see the
top-of-file usage). The multi-user set lives in `scenarios-multiuser.ts`.

## One-time example setup

1. **CI pool app** — create a Slack app from the same manifest as the local pool apps
   (`src/slack/README.md`), named "Agent (ci1)", Socket Mode on. Do **not** reuse
   a local `poolN.env` app: a CI run stealing a slot mid-debug would be miserable.
   → secrets `LIVE_E2E_SLACK_BOT_TOKEN` (xoxb), `LIVE_E2E_SLACK_APP_TOKEN` (xapp).
2. **QA Human** — a real example member account (full member, not guest — guests classify
   differently). Create a second tiny app "QA Driver" with **user** token scopes
   `chat:write, channels:read, channels:write, channels:history, groups:history,
im:history, im:write, reactions:write, files:read, files:write, users:read` and install
   it **as that account** → secret `LIVE_E2E_SLACK_QA_USER_TOKEN` (xoxp). (`files:write`
   lets the QA user upload the selfie in the `photo-identity` scenario; reinstall the app
   if you added it after first install.)
3. **Channels** — create `#ci-target` (public; invite the ci1 bot _and_ QA Human; repo
   var `LIVE_E2E_TARGET_CHANNEL` = its channel id) and `#ci-alerts` (invite the ci1
   bot; repo var `LIVE_E2E_ALERT_CHANNEL` = its id). Failures on main post there.
4. **Remaining secrets** — `LIVE_E2E_ANTHROPIC_API_KEY`, `LIVE_E2E_CORE_SIGNING_SECRET`
   (any random string; the runner instance is loopback-only), and the existing
   `SPRITES_TOKEN` (sandbox turns) and `FLY_API_TOKEN` (the cloudflared self-API tunnel).

Runs are serialized per Slack app by the workflow's concurrency group — that _is_ the
lease; there is no poolN.env machinery in CI.

## Fake-human actors (multi-user scenarios)

Multi-user channel scenarios need several real example member accounts, each with its own
user token, so a scenario reads like a play: `ch.as(bob).mention(...)`,
`ch.as(carol).threadReply(root, ...)`. A scenario declares the actors it needs
(`actors: ["bob","carol"]`); the runner **skips** it unless every declared actor has a
token, and **invites only** those actors to its channel. At boot each actor posts one
warm-up message in a scratch channel (the real lazy Slack→core directory push) and the
runner polls the admin directory until it classifies — an actor that never resolves is
dropped and its scenarios skip, so you never get a mysterious empty-directory miss mid-run.

**Provisioning (~1 hr for five, one-time; the install step is dashboard-manual):**

1. **Five member accounts** via Gmail plus-addressing — `alice+slackqa1@example.com`
   … `+slackqa5`, all landing in your inbox. Invite each to example as a **full member**
   (not guest — guests classify differently). Name them alice … eve.
2. **User tokens** — reuse the "QA Driver" app manifest (same user scopes as the QA Human
   above) and **install it once per account** while signed in as that account; each install
   yields that member's `xoxp` token.
3. **Configure** — either `LIVE_E2E_ACTOR_TOKENS='{"alice":"xoxp-…","bob":"xoxp-…",…}'`
   or one var per actor: `LIVE_E2E_ACTOR_TOKEN_ALICE=xoxp-…`. Names are lowercased.
4. **Verify** before a run: `node test/live-slack/actors-verify.ts` prints each actor's
   handle + user id, or the auth error.

## Screenshots (pixel-truth, local, best-effort)

The gallery reconstructs message content faithfully and links to the real thread; for
actual Slack-rendered pixels run the **decoupled** screenshot sweep after a run. It drives
a _dedicated_ Chrome profile (never your main Chrome), so it's non-disruptive, and gates
each capture on the conversation's text appearing in the DOM — a flaky capture is skipped,
never fatal.

```sh
npm run gallery:shots:login   # one-time: sign into example in the window that opens
npm run gallery:shots         # headless sweep → out/shots/*.png, folds them into gallery.html
```

`LIVE_E2E_SHOTS_PROFILE` overrides the profile dir (default `~/.cache/live-slack-shots-chrome`),
`LIVE_E2E_SHOTS_PORT` the debug port (default 9333).

## Reading a run

**Start with `out/gallery.html`** — one self-contained page (opens offline) that reconstructs
what happened in Slack for _every_ scenario, pass or fail, so you can verify by eye instead of
trusting the LLM judge. Each card shows the driver's messages, the bot's reply, its **full
streaming edit history** (the `⚙ Working…` ticker → `▌` cursor → final text, collapsed under
"N streaming edits"), and a **↗ slack** permalink into the real thread for pixel-true
inspection. Failures sort to the top with their error and core turn errors inline. This is the
primary artifact for the on-demand / feature-push use case.

For deeper debugging, the artifact also has `out/summary.md` (also in the step summary),
`out/results.json` (includes each scenario's timeline), `out/transcripts/*.json` — the failing
scenario's full session entries **and LLM requests** (ground truth for "what did the agent
actually see") — and `.ci-instance/{core,slack}.log`. Don't trust the agent's in-channel
self-explanations; read the transcript.

## Sandbox-provider release qualification

Set `LIVE_E2E_SANDBOX_PROVIDERS=all` with `LIVE_E2E_GATE=1` to require a real
agent `sandbox exec` on every implemented provider: Sprites, AWS, local Docker,
Smolmachines, E2B, Modal, Porter, and Agent37. These eight scenarios run concurrently
in their own lane alongside the selected catalog. The source type requires a
coverage entry when a provider is added. Missing providers, skips, retries,
execution errors, and cleanup errors block release. Provider checks do not retry; a failed first execution blocks qualification.
Release qualification cannot shard away a required provider check.

Alternatively, set `LIVE_E2E_SANDBOX_PROVIDERS` to an explicit comma-separated
provider list. Every listed provider remains mandatory and runs concurrently.
Providers omitted from that list are outside the gate, not failed or skipped
required tests. Empty, unknown, and duplicate provider names are rejected.

Each check creates an isolated sandbox, makes it the default only for its fresh
test channel, and asks the agent to execute a nonce command on its explicit ID.
The assertion requires a correlated tool call and result with exit code zero,
no timeout, and exact stdout. Agent reply text cannot satisfy it. Cleanup clears
the test channel default and retires its named test resources, including failed
provisioning records. Core requests are bounded, cleanup uses a separate deadline,
and the runner waits for provider cleanup to settle before recording an attempt
as timed out. Slack requests time out after 30 seconds without SDK retries
or automatic rate-limit waits; the scenario runner owns retry policy. A cleanup deadline failure remains a release blocker and requires
operator reconciliation of retained resource records.

The target instance must enable sandbox resources and configure every required
provider with real credentials and infrastructure. Local Docker additionally
requires a Docker-capable host and a built sandbox image; a Fargate service alone
cannot supply it. Unconfigured providers are failures, never optional coverage.

When staging cannot host Docker, run `scripts/qualify-local-provider.sh
/path/to/release-candidate.json` as a separate required job on an ephemeral
Docker-capable ARM64 runner. It pulls the candidate's immutable core image from
ECR and checks its embedded source SHA against the checkout. The runner builds
the local sandbox from that source, then invokes the candidate's real application,
Pi harness, model, and sandbox tools. Only the probe and transcript assertion are
mounted into the core container; application code comes from the candidate image.
Provide AWS ECR access and `ANTHROPIC_API_KEY`. Require this job alongside cloud
qualification before promotion. If capturing output through a pipe, use a shell
with `pipefail` so a failed probe cannot become a successful job.
