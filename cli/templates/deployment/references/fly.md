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
`https://<app-prefix>-portal.fly.dev`. Confirm the service and sandbox app names
are available in the selected organization.

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

## Publish the agent computer and deploy

Publish the package-selected sandbox base and record its immutable digest:

```bash
npm exec qm -- sandbox publish
npm exec qm -- secrets push
npm exec qm -- plan
npm exec qm -- up
npm exec qm -- doctor
npm exec qm -- check --live
```

`secrets push` ownership-marks service apps before delivering secrets. When
storage credentials or `DATABASE_URL` are absent, deployment creates or reuses
private Tigris and Managed Postgres.
`check --live` proves service health and durable object storage.

After the first successful deployment, rerun `npm exec qm -- up` and confirm it
reconciles the same apps.

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
