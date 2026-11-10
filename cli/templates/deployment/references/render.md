# Render deployment

Use this after the choices and billing confirmation in `deployment.md`.

## Preflight

Require a Render API key for the workspace that owns the deployment and a
GitHub repository and branch that local Git and Render can read. Render builds
QM services from that source; no local Docker or image publication is
involved, and the deployment needs no Blueprint. Put the key in the generated
`.env` as `RENDER_API_KEY` and keep that file private; Render stores the
runtime values.

```bash
npm exec qm -- init . --org <slug> --target render --repo <url> --branch <name>
```

## Configuration

Set these keys in `qm.config.jsonc`:

- `render.workspaceId`: the authorized test or production workspace
  (`tea-...` or `usr-...`).
- `render.source.repo` and `render.source.branch`: initialization requires
  `--repo` and `--branch`. The repository must contain the Render build and startup
  files. Each `qm up` resolves the branch to one commit and pins QM service
  builds to it. Existing MinIO keeps its selected source commit unless
  `--upgrade-minio` is set. Automatic deploys are off so `qm up` controls the
  update order.
- `render.region`: the region for the core services, Postgres, and MinIO.
  Render creates each sandbox in the default sandbox group of the workspace, so
  this setting does not place sandboxes.
  `render.appRegion` optionally selects the region for new published apps; it
  defaults to `render.region`, and each app keeps the region selected at
  creation.
- `sandbox.baseImage`: optional. Names the QM sandbox base image that Render
  computers start from, as `<repository>:<tag>@sha256:<digest>`; without it
  `qm up` uses the package's pinned sandbox base. A CLI built from source pins
  none, so set it there. Core imports the image and snapshots it once per
  release, and new computers start from that snapshot.
- `render.corePlan`, `render.servicePlan`, and `render.storage.plan`: Render
  compute plan IDs such as `2c-4g`. Retired names such as `standard` are
  rejected with the current ID. `render.corePlan` defaults to `2c-4g`, which fits the
  default 16 run workers; a smaller core plan needs a lower `env.core.WORKERS`.
- `render.postgresPlan` and `render.postgresDiskSizeGB`: passed through to
  Render Postgres for QM core. `render.storage.diskSizeGB` sizes the MinIO disk.
  Each published app starts with a separate 1 GB disk mounted at `/data`.
- `env.core.SHUTDOWN_DRAIN_MS` (default 30000): how long a previous core
  instance gives in-flight turns after SIGTERM. Render ends that instance 300
  seconds after SIGTERM and core needs up to 30 seconds after the drain to
  exit, so keep the value at most 270000.
- `publicUrl` and `apiUrl`: core serves both from one Render web service, so
  both start as its assigned `onrender.com` URL and work without DNS changes.
  To use custom domains, set them to HTTPS origins and run `qm up`. The CLI adds
  each hostname to core and prints the DNS record to create. They may share one
  hostname, but not an apex domain and its `www` subdomain. Until the domains are
  verified, sandboxes and published apps cannot reach core and
  `qm check --live` fails. Run `qm slack render` after changing
  `publicUrl`. A hostname removed from the config stays on its service until it
  is removed in the Render dashboard.

## Deploy

```bash
npm exec qm -- setup .
npm exec qm -- slack render
npm exec qm -- check
npm exec qm -- secrets push
npm exec qm -- plan
npm exec qm -- up
npm exec qm -- doctor
npm exec qm -- check --live
```

`qm up` creates one project with one production environment for core (which
also serves the web UI and sign-in), Render Postgres, and bundled MinIO,
initializes MinIO before it deploys core, applies registered database
migrations, and uploads the deployment layer.
Each published app gets a network-isolated environment and one persistent disk
in the same project. Apps use SQLite at `/data/app.db`, with `DATA_DIR=/data`.
Litestream 0.3.13 backs up this SQLite database to `S3_PREFIX + "litestream"` in MinIO,
using the app's scoped credentials. Only Litestream receives these credentials;
the app's environment does not include them. The runner restores a missing local SQLite file
before it starts the app. An existing local file takes precedence over backups.
Other files under `/data` persist on the disk but have no Litestream backup.
App updates have downtime because Render stops the old instance before the new
instance mounts the disk. Archive retains the disk and backup; restore reuses
them. SQLite backups are asynchronous and can lose recent writes after disk
loss. App code rollback does not reverse SQLite schema changes.
Native Render Sandboxes are workspace resources; do not create a second project
for them. The CLI records resource IDs and the selected MinIO repository,
branch, and commit in `render.resources.json`. Existing deployments record
their successful MinIO source before the first update with this CLI. Retain this
file so updates act on the same resources. `qm up`, `qm down`, `qm rollback`,
and `qm secrets push` take `.render.lock` in the deployment directory. A second
such command waits up to 30 seconds for the holder and otherwise stops with an
error. A retry after an interruption cancels any build still running and
deploys the selected commit. MinIO retains its selected source commit
when storage settings change, when a service resumes, and when a deployment
is retried. The first deployment builds MinIO from the selected QM source.
`check --live` proves service health and durable object storage.

To upgrade a deployment that has separate `web-ui` and `portal` services, once:

1. Use a CLI version that includes this change, and set `render.source.branch`
   to a branch that contains it. In `qm.config.jsonc`,
   remove `"web-ui"` and `"portal"` from `services`. `qm plan` does not list
   the services this leaves behind; `qm up` reports them.
2. Run `qm up`. Core takes over `publicUrl`. An assigned `onrender.com` URL
   changes from the portal's (`…-portal.onrender.com`) to core's
   (`…-core.onrender.com`), so bookmarks, Slack links and OAuth redirect URLs
   that name the portal's URL stop working once the portal is deleted. For a
   custom domain, `qm up` adds it to core and prints the DNS record. If Render
   reports that the portal still holds the domain, remove it from the portal
   service (Settings, Custom Domains) and run `qm up` again; the site is down
   until the next step finishes. Render can take about a minute after `qm up`
   returns to route core's URL to its new port; until then that URL answers
   with the API instead of the sign-in page.
3. For a custom domain, point its DNS record at core's host and wait until
   `qm check --live` passes.
4. Delete the `web-ui` and `portal` services in the Render dashboard or through
   the Render API. Until then `qm up` lists them as retained services;
   afterwards it drops them from `render.resources.json`.
5. Run `qm slack render` and update OAuth redirect URLs if `publicUrl` changed.

A rollback to a release from before the upgrade fails because those services
are gone. Web UI changes ship with `qm up`, which rebuilds core;
`qm ui publish` does not support Render.

After the first successful deployment, rerun `npm exec qm -- up` and confirm it
reconciles the same resources.

## Agent-computer proof

Render keeps the agent computer through native filesystem snapshots. It does
not write a home archive to MinIO. In the review browser, ask the agent to write
a new UUID to `qm-computer-proof.txt` with `execute`, then read the file with a
second command. Require the exact UUID in the tool output.

After a successful native snapshot, restart the computer through QM and ask
the agent to read the file again without creating it. Require the same UUID.
Check the computer status for the snapshot ID and a new sandbox ID. A missing
file, a different value, or a failed snapshot is a failed proof. Native
snapshots have a provider expiry time. If the sandbox and its snapshot are no
longer available, QM refuses an empty replacement. Keep durable work in Git or
Files.

QM creates every computer with Render's idle suspension disabled and a 30-day
lifetime, so files and background processes stay in place between turns. After
an hour without use and with no running process, QM checkpoints and stops the
computer; the next use restores its files from that checkpoint, but not its
processes. Disposable sandboxes keep a 24-hour lifetime.

Render sandbox recovery does not require `S3_BUCKET` or `SNAPSHOT_STORE=s3`.
The hosted stack still sets these values for durable files, tool output, app
repositories, and shared session files.

Routine operations:

```bash
npm exec qm -- status
npm exec qm -- logs core --follow
npm exec qm -- up --upgrade-minio
npm exec qm -- rollback --to <release-label-commit-or-deploy-id>
npm exec qm -- down
```

`up --upgrade-minio` explicitly selects the current source commit for MinIO.
The CLI saves that selection before deployment. If deployment fails or its
reply is lost, a normal `up` retries the same selected version, even if the QM
branch advances. Use the flag again to select another version. The persistent
disk remains attached, but deployment can briefly stop storage access.

`rollback` restores the previous successful service builds, retains the current
operator environment values, and does not reverse database migrations. A
release that needs a setting which the current configuration no longer provides
can fail to start; Render keeps the previous instance serving, and `rollback
--to` selects another release. The CLI retains every release in
`render.resources.json`; `qm status` lists them. `down` suspends the services; Postgres and the MinIO disk keep running and
continue to incur charges. Archive published apps before stopping their parent
deployment. `down --purge` deletes the recorded QM services, Postgres, and MinIO
disk and stored objects, including app SQLite backups. Before purge, back up
app data and delete app services and their disks. Purge refuses to continue while
app services remain. It retains the project and workspace sandboxes. Use it only with explicit authorization to
delete the deployment and its stored data. Do not change unrelated
infrastructure, DNS, or Cloudflare rules.
