# QM Helm chart

This chart runs the core image as two Deployments, plus the optional egress proxy:

- **edge** (`node src/edge/main.ts`) serves the API on `services.core.port` (8080) and,
  when `services.portal.enabled`, the public front door on `services.core.publicPort`
  (8000): the portal with the embedded `/idp` auth broker, the web UI and `/admin`.
  Its Service keeps the name `<fullname>-core`, so `CORE_API_URL` and in-cluster clients
  are unchanged.
- **harness** (`node src/harness/main.ts`) claims and runs agent turns, crons and
  sweeps. It serves only `/healthz` and `/readyz` on `services.core.port`, has no
  Service or ingress, and gets `terminationGracePeriodSeconds: 300` to drain in-flight
  turns.

Both share `services.core` (image, port, probes, persistence, `env`) and the same
secrets; `services.core.edge` and `services.core.harness` hold each workload's replicas,
command, grace period and resources. Both run migrations at boot under an advisory lock.
`services.portal`, `services.auth` and `services.admin` toggle modules hosted by the
edge and carry their `env`; auth and admin require the portal.

## Images

There is deliberately no default image tag. Build all enabled services from the
same checked-out QM revision that supplies this chart, or independently verify a
release's core image includes `src/edge/main.ts` and `src/harness/main.ts`. Older
images and the retired web-ui, portal, auth and admin images are not compatible. The
chart version is **not** an application image version.

For example, from the repository root, with a registry you own and are signed into:

```bash
export REGISTRY=registry.example.com/your-project/qm
export TAG=$(git rev-parse HEAD)
for service in core egress-proxy; do
  docker buildx build --platform linux/amd64 --push \
    --build-arg GIT_SHA="$TAG" \
    -f "deploy/$service/Dockerfile" -t "$REGISTRY/$service:$TAG" .
done
cat > images.yaml <<EOF_IMAGES
image:
  repository: $REGISTRY
  tag: "$TAG"
EOF_IMAGES
```

Use the architecture of your cluster. A commit tag identifies the build only if
that checkout is clean; use a unique tag when testing uncommitted changes. For
immutable deployments, set each enabled service's `imageRef` to its full registry
reference, such as `registry.example.com/your-project/qm/core@sha256:<digest>`.
`imageRef` takes precedence over repository/tag composition. Otherwise
`services.<name>.tag` overrides `image.tag`. Configure `imagePullSecrets` for a
private registry. Neither this chart nor these examples publish an official release.

## Cluster setup

Bring these before installing:

- Kubernetes, Helm 3, a reachable durable Postgres database, and backups.
- A supported sandbox backend and its credentials. Kubernetes hosting does not
  configure sandbox provisioning or app hosting automatically.
- DNS and an ingress controller. For TLS, provision the referenced certificate or
  install cert-manager with the configured ClusterIssuer.
- The signing/encryption secrets, portal session secret, first administrator grant,
  sign-in allowlist, auth client/signing configuration and email transport described
  in [the deployment reference](../../docs/porter.md) and
  [`src/deployment/secret-schema.ts`](../../src/deployment/secret-schema.ts).

Store credentials in a Kubernetes Secret and use `envFrom`, or supply `secretEnv`
through a protected values file. Helm stores `secretEnv` values in its release
history. Never commit these values.

Settings that belong to the install's tenant go under `tenantSettings`, not in any
service's environment: `ADMIN_GRANTS`, `AUTH_ALLOWED_EMAILS` or
`AUTH_ALLOWED_EMAIL_DOMAIN`, the front door's `OIDC_*` values and
`PORTAL_EXPECTED_TEAM_ID`. The chart refuses them in `env`, `secretEnv` or
`services.<name>.env`. After each install or upgrade, a hook Job running the core
image creates the tenant named by `tenant` (default `main`) on a fresh install
(`PUT /v1/install/tenant`; once tenants exist the slug must be one of them, or the
Job fails with `unknown_tenant`) and writes these settings to it (`PUT /v1/tenant-settings`), signed with `CORE_SIGNING_SECRET` and
authorized by `DEPLOYMENT_CONTROL_SECRET`. With the embedded auth broker, the chart
derives the front door's OIDC endpoints, sets `OIDC_CLIENT_ID` to `qm-portal`, and copies
`AUTH_CLIENT_SECRET` from `secretEnv` and the auth allowlist into the matching `OIDC_*`
settings; an explicit `tenantSettings.OIDC_*` value wins. With `envFrom`, set
`tenantSettings.OIDC_CLIENT_SECRET` yourself, since Helm cannot read an external Secret.
The web UI's old access lists (`WEB_UI_PRINCIPALS`, `LOOPS_USERS`,
`WEB_UI_VOICE_USERS`) are still read from `secretEnv`, `env` or
`services.core.env` and sent with these settings, empty when unset, so upgrades
keep the same people's access; they are no longer passed to any service.

The ingress routes to the edge's Service. `ingress.service: portal` (the default)
targets the front door port and should normally be the only public ingress;
`ingress.service: core` targets the API port instead, which is an operator choice and not
required for the portal setup.

A minimal **Kubernetes configuration fragment**, not a complete installation:

```yaml
publicUrl: https://qm.example.com
imagePullSecrets:
  - name: registry-credentials
envFrom:
  - secretRef:
      name: qm-runtime
ingress:
  enabled: true
  service: portal
  hosts: [qm.example.com]
  className: nginx
  clusterIssuer: letsencrypt-prod
services:
  core:
    harness:
      replicas: 2
    env:
      SNAPSHOT_STORE: s3
      TRANSFER_STORE: s3
      S3_BUCKET: qm-example-data
      S3_REGION: us-west-2
```

This fragment expects `DATABASE_OWNER_URL`, `DATABASE_URL`, `DATABASE_READER_URL`,
`DEPLOYMENT_CONTROL_SECRET`, a remote `SANDBOX_BACKEND` and S3 credentials
in `qm-runtime`; see
[Core data and rollout behavior](#core-data-and-rollout-behavior). After supplying
runtime config and `images.yaml`, render and inspect before applying:

```bash
helm lint deploy/helm -f images.yaml -f cluster.yaml
helm template qm deploy/helm -f images.yaml -f cluster.yaml
helm upgrade --install qm deploy/helm --namespace qm --create-namespace \
  -f images.yaml -f cluster.yaml --wait --timeout 10m
```

Validate the complete installation: test your database, ingress/TLS,
sign-in, real turns, sandbox provider and backup/restore in your target cluster.

## Core data and rollout behavior

Core keeps durable state in two places: Postgres and an object store for file
bytes. Postgres takes three logins: `DATABASE_OWNER_URL` owns the tables and runs
migrations, `DATABASE_URL` is the `qm_app` login requests use (not the owner, not
a superuser, no `BYPASSRLS`) and `DATABASE_READER_URL` is `qm_reader`. The
migrations create `qm_app` and `qm_reader`, and core sets their passwords from the
URLs. Core refuses to start without `DATABASE_OWNER_URL`, or when `DATABASE_URL`
logs in as the owner, a superuser or a role that bypasses row-level security.
Edge and harness share both. Choose one of two layouts.

**Shared storage (recommended, supports multiple replicas).** Set `DATABASE_URL`
with `SNAPSHOT_STORE=s3`, `TRANSFER_STORE=s3`, `S3_BUCKET`
and `S3_REGION` (optionally `S3_PREFIX`) on core, use a remote `SANDBOX_BACKEND`,
and leave `services.core.persistence` disabled. Edge and harness then scale
independently through `services.core.edge.replicas` and `services.core.harness.replicas`. Sessions and runs then live in
Postgres, and uploaded artifacts, session shares, published-app source archives and
sandbox file transfers go to the bucket, so replicas share that state and pods can
be replaced with rolling updates. Core refuses to start without `DATABASE_URL`. S3
credentials come from the standard AWS chain, such as a pod IAM role bound through
`serviceAccount.create=true` with `serviceAccount.annotations`, or
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the runtime Secret. Any S3-compatible
store works outside AWS: set `AWS_ENDPOINT_URL_S3` to its endpoint (for example
Cloudflare R2, Tigris or Google Cloud Storage with HMAC keys) and `S3_REGION` to
what it expects, such as `auto` for R2. `/data` is then
pod-local, and a few things still live only on the replica that created them:
agent workspace files outside `artifacts/` (including files shared from there) and
pending ChatGPT device logins. The chart sets no session affinity, so these can be
unavailable from another replica and are lost on pod replacement. Switching an
existing volume-backed install to S3 does not migrate bytes already under `/data`;
copy `/data/docstore/` to the bucket under `S3_PREFIX` and `/data/session-shares/`
under `<S3_PREFIX>session-shares/` first, or existing uploads and shares become
unreadable.

**Local volume (single replica).** Without an object store, core writes file bytes
under `/data`, and they are lost when the pod is replaced even with Postgres
configured. `services.core.persistence.enabled=true` mounts one ReadWriteOnce PVC at
`/data` in both edge and harness, sets `DATA_DIR=/data` and uses group 1000 for the Node
image's volume permissions. A ReadWriteOnce volume attaches to one node, so the harness
gets a required pod affinity that schedules it on the edge's node; it stays Pending while
the edge has zero replicas. Storage drivers must support `fsGroup`, or an existing volume must
already be writable by UID/GID 1000.

Each persistent workload supports zero or one replica, with `Recreate` deployment strategy
so upgrades do not mount the same data concurrently. Expect downtime on upgrades;
shared-storage multi-replica operation over a volume is not supported. Use the
object-store layout for high availability. `replicas: 0` scales down without
discarding the claim.

The chart-created `<fullname>-core-data` claim has `helm.sh/resource-policy: keep`;
it is retained on uninstall or when persistence is removed. It is not a backup.
Record the actual claim name before uninstalling. Reinstall with
`services.core.persistence.existingClaim=<name>` and persistence enabled to reuse
it, rather than trying to create the retained claim again. Existing claims are
never created or deleted by this chart. Delete retained data manually only when
you intend to discard it. A null `storageClass` selects the cluster default; `""`
requests no storage class. Existing-claim size and class are managed externally.

`services.core.port` and `services.core.publicPort` control the processes, Service and
probes; conflicting `PORT` or `PUBLIC_PORT` values are rejected. The egress-proxy image's Envoy listener is fixed at
48080, so other proxy ports are rejected rather than rendered as broken Services.

Edge and harness liveness use `healthPath: /healthz`; readiness uses
`readinessPath: /readyz`. Their startup probe allows five minutes for initialization
before liveness begins. Override `startupProbe` fields as needed, or set it to null
to disable. Helm merges probe maps, so set `startupProbe.httpGet: null` when
switching to an `exec` or `tcpSocket` handler. When overriding endpoint paths,
update the startup probe too. Database unavailability should remove the edge from
endpoints, not restart either workload through liveness.

## Upgrading from chart 0.2

Chart 0.3 replaces the core, web-ui and portal Deployments with edge and harness.
Before upgrading:

- Build and push only `core` and `egress-proxy` images; drop `services.web-ui`,
  `services.portal.image`/`tag`/`imageRef` and any per-service image settings for
  web-ui, portal, auth or admin.
- Move `services.core.replicas`, `command` and `resources` under
  `services.core.edge` and `services.core.harness`. Shared settings (`image`,
  `imageRef`, `tag`, `port`, probes, `persistence`, `env`) stay on `services.core`.
- Move environment from `services.web-ui.env` to `services.admin.env` or
  `services.portal.env`, except the web UI access lists (`WEB_UI_PRINCIPALS`,
  `LOOPS_USERS`, `WEB_UI_VOICE_USERS`), which go to `tenantSettings`; module `env`
  maps must agree on shared keys. Drop `PORT`
  overrides from module `env`.
- Set `ingress.service` to `portal` or `core`; `web-ui` is rejected.
- To run without the front door, disable `services.portal`, `services.auth` and
  `services.admin` together.

The upgrade deletes the old core, web-ui and portal pods and starts edge and harness
in their place, so expect a short outage. A chart-created `<fullname>-core-data` claim
keeps its name and is mounted by both new workloads.

## Regression tests

Install Helm 3 on PATH (or set `HELM_BIN`) and run:

```bash
node --test test/helm-chart.test.ts
```

These tests render real manifests and parse them with Helm's YAML parser. Missing
Helm is a local skip and a CI failure. They do not replace live Kubernetes tests.
