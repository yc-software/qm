# Fly.io deployment

Use this after the choices and billing confirmation in `deployment.md`.

## Preflight

Require authenticated Flyctl, Docker Buildx, and permission to create apps,
Managed Postgres, and private object storage:

```bash
fly auth whoami
fly orgs list
docker buildx version
```

Set `flyOrg`, `region`, globally unique `appPrefix`, `publicUrl`, and
`sandbox.app`. The public origin is normally
`https://<app-prefix>-core.fly.dev`, served by the core app. Confirm the service
and sandbox app names are available in the selected organization.

Create the sandbox registry app before setup. Setup refuses to mint a token
until the app exists and verifies that the new app-scoped token can list its
Machines:

```bash
fly apps create <sandbox-app> --org <fly-org>
npm exec qm -- setup .
npm exec qm -- slack render
npm exec qm -- check
```

Setup keeps the sandbox deploy token separate from the organization deploy
token. Do not substitute a personal token.

## Deploy

```bash
npm exec qm -- secrets push
npm exec qm -- plan
npm exec qm -- up
npm exec qm -- doctor
npm exec qm -- check --live
```

`secrets push` ownership-marks service apps before delivering secrets. When
storage credentials or `DATABASE_URL` are absent, deployment creates or reuses
private Tigris and Managed Postgres. The core defaults to a
2-CPU performance VM with 4 GB of memory for its 16 workers.
`check --live` proves service health and durable object storage.

After the first successful deployment, rerun `npm exec qm -- up` and confirm it
reconciles the same apps.

## Upgrade from separate web UI, portal and auth apps

Deployments created before core served the web UI also run
`<app-prefix>-web-ui`, `<app-prefix>-portal` and `<app-prefix>-auth` apps. Move
to core once, by hand:

1. In the config, remove `"web-ui"` and `"portal"` from `services`, move their
   `env` and `secretEnv` entries into `core`, and delete their `vms` and
   `imageOverrides` entries. If `imageOverrides.core` pins an image from
   before the upgrade, delete it too; `qm up` deploys a pinned image instead
   of the release's.
2. If `publicUrl` is `https://<app-prefix>-portal.fly.dev`, change it to
   `https://<app-prefix>-core.fly.dev`. Do the same for `PUBLIC_API_URL` if it
   names the old host. If sign-in goes through an external OIDC provider,
   register `<publicUrl>/auth/callback` as its redirect URI.
3. Run `npm exec qm -- secrets push`, then `npm exec qm -- up`.
4. Check that `https://<app-prefix>-core.fly.dev/healthz` answers and that you
   can sign in at the core URL. Then run `npm exec qm -- check --live`.
5. For each custom domain in `fly certs list -a <app-prefix>-portal`, run
   `fly certs add <hostname> -a <app-prefix>-core`, point its DNS at the
   addresses from `fly ips list -a <app-prefix>-core`, wait until
   `fly certs show <hostname> -a <app-prefix>-core` reports it issued, then run
   `fly certs remove <hostname> -a <app-prefix>-portal`.
6. Run `fly apps destroy <app-prefix>-portal`, then
   `fly apps destroy <app-prefix>-web-ui` and
   `fly apps destroy <app-prefix>-auth`; skip any app that does not exist.
   Deployments that signed in through the portal never had an `-auth` app.

## Web UI releases

`npm exec qm -- ui publish --dir <built dist-web>` makes a new web UI live in
seconds without restarting core; `--release <id>` switches back. The bucket is
Tigris, so export `AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev` and an
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair for `env.core.S3_BUCKET`.
Create one in the Tigris dashboard that `fly storage dashboard <bucket>` opens,
or, without a browser, reuse core's pair from
`fly ssh console -a <app-prefix>-core -C 'printenv AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY'`.
The command runs AWS CLI v2, which must be installed.

## Agent-computer proof

Use the exact signed-in principal to select one sandbox Machine by its
`agent_scope` metadata. Read `/root/workspace/qm-computer-proof.txt` with
`fly machine exec` and require it to match the UUID created in the browser. A
missing or ambiguous scope match is a failed proof.

Routine operations:

```bash
npm exec qm -- status
npm exec qm -- logs core --follow
npm exec qm -- rollback --to <sandbox-digest-or-tag>
npm exec qm -- down
```

`down` stops the control-plane apps. It does not authorize deleting Postgres,
object storage, sandbox Machines, or volumes.
