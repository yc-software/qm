# Running QM locally for vocatale

A single-machine QM instance: core, web UI, admin, and the portal front door on your own
computer, with Postgres and the agent sandbox in Docker. No Slack app and no cloud account
required. This is the setup to use when vocatale is one person or a couple of people
working through the browser.

The `dev-instance` skill is a different thing — it is branch QA that claims a Slack app
slot from a pool and refuses to boot without one. Use this runbook instead.

## What you need first

- Node 24.18.0 (the version in `.node-version`; core requires `>=24.15.0`) and npm `>=11.10.0`
- Docker, running — Docker Desktop or OrbStack on macOS, the daemon on Linux, Docker
  Desktop with the WSL2 backend on Windows
- An Anthropic API key, or an OpenAI/OpenRouter key if you prefer that provider

## 1. Install dependencies

```bash
git clone <your qm fork> qm && cd qm
npm install
npm install --prefix plugins/web-ui
```

The admin and portal plugins need no install of their own; they resolve their two
dependencies from the root `node_modules`.

## 2. Start Postgres

```bash
docker run -d --name qm-vocatale-pg -p 5433:5432 \
  -e POSTGRES_USER=qm -e POSTGRES_PASSWORD=qm -e POSTGRES_DB=qm_vocatale \
  -v qm-vocatale-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

Port 5433 keeps it clear of a Postgres you may already run on 5432. There is no migration
step: every store creates its own tables on first use, so an empty database is the right
starting point. The named volume is what makes the instance durable — sessions, memory,
files, crons, and the audit log all live there, and they survive `docker restart`.

## 3. Write the environment file

Copy the template to the repository root — core, web UI, and admin all read `.env` from
there — and fill it in:

```bash
cp deploy/layers/vocatale/env.local.example .env
```

Then:

- **Secrets.** Every empty secret in the file needs a value of at least 32 characters.
  Generate them all at once:

  ```bash
  for k in CORE_SIGNING_SECRET CAPABILITY_SECRET PORTAL_IDENTITY_SECRET \
           CONNECTOR_SECRET_KEY SKILL_SIGNING_SECRET PORTAL_SESSION_SECRET; do
    printf '%s=%s\n' "$k" "$(openssl rand -hex 32)"
  done
  ```

  Paste the output over the empty lines. Core refuses to boot on a short or placeholder
  signing secret rather than running with weak signing.

- **Model.** `ANTHROPIC_API_KEY=sk-ant-...` with the `MODEL_PROVIDER=anthropic` and
  `HARNESS=pi` already in the template. For OpenAI set `MODEL_PROVIDER=openai`,
  `HARNESS=codex`, and `OPENAI_API_KEY`; for OpenRouter set `MODEL_PROVIDER=openrouter`
  and `OPENROUTER_API_KEY`.

- **Your admin principal.** Replace `you` in `ADMIN_GRANTS=you:org_admin` with the
  identifier you want to be signed in as — your OS username is a fine choice. Use that
  same string as `PORTAL_DEV_PRINCIPAL` in step 5, or the browser signs you in as somebody
  with no admin rights.

## 4. Build the sandbox image and the web UI

```bash
npm run sandbox:local:build
npm run build --prefix plugins/web-ui
```

The first builds `qm-sandbox-local:latest`, the container the agent's `execute` tool runs
in — its durable computer. Skip it and the instance still boots and chats, but every turn
that runs a command fails. It is a large image; expect the first build to take a while.

The second produces `plugins/web-ui/dist-web/`. Rerun it after any change to the web UI
source.

## 5. Start the four processes

Each in its own terminal, from the repository root:

```bash
# core — API, scheduler, agent loop
npm start
```

```bash
# web UI surface
PORT=8081 CORE_API_URL=http://localhost:8080 CORE_ORG_ID=vocatale \
WEB_UI_BASE=/ WEB_UI_PUBLIC_URL=http://localhost:8083 WEB_UI_PRINCIPALS= \
CORE_SIGNING_SECRET="$(grep '^CORE_SIGNING_SECRET=' .env | cut -d= -f2-)" \
node plugins/web-ui/server/index.ts
```

```bash
# admin surface
PORT=8082 CORE_API_URL=http://localhost:8080 CORE_ORG_ID=vocatale \
ADMIN_BASE_PATH=/admin \
CORE_SIGNING_SECRET="$(grep '^CORE_SIGNING_SECRET=' .env | cut -d= -f2-)" \
node plugins/admin/src/index.ts
```

```bash
# portal — the front door you actually open
PORT=8083 CORE_API_URL=http://localhost:8080 CORE_ORG_ID=vocatale \
PORTAL_PUBLIC_URL=http://localhost:8083 \
WEB_UI_UPSTREAM=http://localhost:8081 ADMIN_UPSTREAM=http://localhost:8082 \
NODE_ENV=development PORTAL_LOCAL_AUTH_BYPASS=1 PORTAL_DEV_PRINCIPAL=you \
PORTAL_SESSION_SECRET="$(grep '^PORTAL_SESSION_SECRET=' .env | cut -d= -f2-)" \
CORE_SIGNING_SECRET="$(grep '^CORE_SIGNING_SECRET=' .env | cut -d= -f2-)" \
node plugins/portal/src/index.ts
```

Open **http://localhost:8083** — the assistant at `/`, the admin panel at `/admin/`.

`PORTAL_LOCAL_AUTH_BYPASS=1` replaces the OIDC sign-in with a local session as
`PORTAL_DEV_PRINCIPAL`. The portal only honours it when `PORTAL_PUBLIC_URL` is a localhost
address and `NODE_ENV` is not `production`, so it cannot leak into a deployment — but it
does mean anything that can reach port 8083 is you. Keep the ports bound to your own
machine and do not port-forward them.

## 6. Use it for vocatale

Once you are in, the pieces worth setting up first:

- Give the agent the vocatale repository or documents through the sandbox, and let it keep
  what it learns in scope memory.
- Put recurring work — a weekly status pass, an inbox triage, a CI watch — on crons, which
  run in Postgres and survive restarts.
- Use a project scope for vocatale so its memory, files, and crons stay separate from your
  personal scope.

## Operating it

- **Stopping.** Ctrl-C each process. The Postgres container keeps running; `docker stop
  qm-vocatale-pg` when you want it down, `docker start qm-vocatale-pg` to bring it back.
- **Backups.** Everything durable is in the `qm-vocatale-pgdata` volume:
  `docker exec qm-vocatale-pg pg_dump -U qm qm_vocatale > backup.sql`.
- **Upgrading.** `git pull`, then repeat steps 1 and 4 — new dependencies and a fresh web
  UI build — before restarting. Tables migrate themselves.
- **Logs.** Each process logs to its own terminal. Core logs the port it bound and the
  stores it chose at startup; that line is the fastest check that `.env` was read.

## When something does not start

- `missing or insecure required core secrets: …` — a secret in `.env` is empty, shorter
  than 32 characters, or still a placeholder.
- `SANDBOX_BACKEND=local requires a running Docker daemon` — Docker is not up.
- Turns fail the moment the agent runs a command — the sandbox image is missing; run
  `npm run sandbox:local:build`.
- The web UI answers with `not_built` — run `npm run build --prefix plugins/web-ui`.
- Everything loads but you have no admin rights — `PORTAL_DEV_PRINCIPAL` does not match the
  principal in `ADMIN_GRANTS`.
- The agent replies with canned text and never calls a model — `HARNESS` is unset, which
  means `mock`.

## If you outgrow the laptop

A local instance is reachable only from your machine and only while it is awake. When
vocatale wants Slack, teammates, or crons that fire overnight, move to a real deployment —
`qm init` against Fly or AWS, described in the repository README and `deployment.md`. The
`.env` here maps onto that deployment's secrets one for one, so nothing is thrown away.
