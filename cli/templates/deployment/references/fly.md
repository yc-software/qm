# Fly.io deployment

Use this after the choices and billing confirmation in `deployment.md`.

## Preflight

Require authenticated Flyctl and permission to create apps, Managed Postgres,
and private object storage:

```bash
fly auth whoami
fly orgs list
```

Set `flyOrg`, `region`, globally unique `appPrefix`, and `publicUrl`. The
public origin is normally `https://<app-prefix>-portal.fly.dev`. Confirm the
service app names are available in the selected organization. Fly agent
computers use the stock Sprites runtime; do not configure a sandbox app, image,
resident environment, Dockerfile, or tool binaries.

```bash
npm exec qm -- setup .
npm exec qm -- slack render
npm exec qm -- check
```

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
private Tigris and Managed Postgres.
`check --live` proves service health and durable object storage.

After the first successful deployment, rerun `npm exec qm -- up` and confirm it
reconciles the same apps.

## Agent-computer proof

As the exact signed-in principal, ask the agent to write a fresh UUID to
`/home/sprite/workspace/qm-computer-proof.txt`. Start a later turn in the same
scope, ask it to read the file, and require the value to match. A missing or
different value is a failed persistence proof.

Routine operations:

```bash
npm exec qm -- status
npm exec qm -- logs core --follow
npm exec qm -- down
```

`down` stops the control-plane apps. It does not authorize deleting Postgres,
object storage, sandbox Machines, or volumes.
