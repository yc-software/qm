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

Deployments created before core served the web UI also have `<app-prefix>-web-ui`,
`<app-prefix>-portal` and `<app-prefix>-auth` apps. Remove `"web-ui"` and
`"portal"` from `services`, move their `env` entries into `env.core`, and change a
`publicUrl` of `https://<app-prefix>-portal.fly.dev` to
`https://<app-prefix>-core.fly.dev` (and a `PUBLIC_API_URL` on the old host, then
run `qm secrets push`; and the redirect URI registered with an external OIDC
provider to `<publicUrl>/auth/callback`). `qm up` then deploys core
with the public front door and, once `https://<app-prefix>-core.fly.dev/healthz`
answers, destroys the three old apps. A custom domain whose certificate is on the
portal app keeps them running until the certificate moves to the core app; `qm up`
prints the steps.

## Web UI releases

`npm exec qm -- ui publish --dir <built dist-web>` makes a new web UI live in
seconds without restarting core; `--release <id>` switches back. The bucket is
Tigris, so export `AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev` and an
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair for `env.core.S3_BUCKET`,
created in the Tigris dashboard that `fly storage dashboard <bucket>` opens.

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
