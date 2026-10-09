# QM Helm chart

This chart runs core, web-ui (including `/admin`), portal (including `/idp` auth),
and the optional egress proxy. `services.auth` and `services.admin` configure
embedded modules, not separate Deployments or Services.

## Images

There is deliberately no default image tag. Build all enabled services from the
same checked-out QM revision that supplies this chart, or independently verify a
release's images include the combined topology and core `/readyz` endpoint. Old
standalone auth/admin images are not compatible. The chart version is **not** an
application image version.

For example, from the repository root, with a registry you own and are signed into:

```bash
export REGISTRY=registry.example.com/your-project/qm
export TAG=$(git rev-parse HEAD)
for service in core web-ui portal egress-proxy; do
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
history. Never commit these values. With `envFrom`, explicitly provide both
`AUTH_ALLOWED_EMAILS` and `OIDC_ALLOWED_EMAILS` (or both corresponding domain
variables); Helm cannot inspect externally supplied Secret values. When `envFrom`
is present, the chart does not derive OIDC allowlist environment entries from
`env` or `services.auth.env`, since those entries would override a potentially
narrower policy in an external Secret. Set OIDC explicitly in values or the external
Secret, including when mixing auth values with `envFrom`. Without `envFrom`, auth
allowlists in `env` or `services.auth.env` propagate unless explicit OIDC values
in `env` or `secretEnv` override them. Auth allowlists in `secretEnv` are aliased
inside the chart-managed Secret; later `envFrom` sources retain their precedence.

Only portal should normally have public ingress. `ingress.service` accepts an
enabled `portal`, `core` or `web-ui`, not embedded modules or the TCP egress proxy.
Exposing core or web-ui is an operator choice, not required for the portal setup.

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
    replicas: 2
    env:
      SESSION_STORE: postgres
      SNAPSHOT_STORE: s3
      TRANSFER_STORE: s3
      S3_BUCKET: qm-example-data
      S3_REGION: us-west-2
```

This fragment expects `DATABASE_URL`, a remote `SANDBOX_BACKEND` and S3 credentials
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

Core keeps durable state in two places: Postgres (`DATABASE_URL`) and an object
store for file bytes. Choose one of two layouts.

**Shared storage (recommended, supports multiple replicas).** Set `DATABASE_URL`
with `SESSION_STORE=postgres`, `SNAPSHOT_STORE=s3`, `TRANSFER_STORE=s3`, `S3_BUCKET`
and `S3_REGION` (optionally `S3_PREFIX`) on core, use a remote `SANDBOX_BACKEND`,
and leave `services.core.persistence` disabled. Sessions and runs then live in
Postgres, and uploaded artifacts, session shares, published-app source archives and
sandbox file transfers go to the bucket, so replicas share that state and pods can
be replaced with rolling updates. Without `SESSION_STORE=postgres`, sessions and
runs stay in process memory even when `DATABASE_URL` is set; an explicit
`RUN_STORE=memory` also keeps runs there. S3
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
configured. `services.core.persistence.enabled=true` mounts a ReadWriteOnce PVC at
`/data`, sets `DATA_DIR=/data` and uses group 1000 for the Node image's volume
permissions. Storage drivers must support `fsGroup`, or an existing volume must
already be writable by UID/GID 1000.

Persistent core supports zero or one replica, with `Recreate` deployment strategy
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

`services.<name>.port` controls the process, Service and probes; conflicting
`PORT` values are rejected. The egress-proxy image's Envoy listener is fixed at
48080, so other proxy ports are rejected rather than rendered as broken Services.

Core liveness uses `healthPath: /healthz`; readiness uses
`readinessPath: /readyz`. Its startup probe allows five minutes for initialization
before liveness begins. Override `startupProbe` fields as needed, or set it to null
to disable. Helm merges probe maps, so set `startupProbe.httpGet: null` when
switching to an `exec` or `tcpSocket` handler. When overriding endpoint paths,
update the startup probe too. Database unavailability should remove core from
endpoints, not restart it through liveness.

## Regression tests

Install Helm 3 on PATH (or set `HELM_BIN`) and run:

```bash
node --test test/helm-chart.test.ts
```

These tests render real manifests and parse them with Helm's YAML parser. Missing
Helm is a local skip and a CI failure. They do not replace live Kubernetes tests.
