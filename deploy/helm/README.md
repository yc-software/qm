# QM Helm chart

This chart runs core and the optional egress proxy. Core serves its API on
`services.core.port` (8080) for in-cluster callers such as the egress proxy, and the
public front door on `services.core.publicPort` (8000): sign-in, the web UI with its
administrator settings at `/settings`, and the agent-facing API. With `auth.enabled`
(the default) the built-in email sign-in broker runs inside core under `/idp`; set it
to `false` to sign in through an external OIDC provider configured with `OIDC_*`
values.

## Resource labels

Set `additionalLabels` to a map of strings to attach labels to the metadata of
every resource created by the chart: Deployments, Services, Ingress, Secret,
ServiceAccount and PersistentVolumeClaim. It defaults to `{}`.

```yaml
additionalLabels:
  example.com/deployment-revision: "123"
  example.com/environment: staging
```

These labels do not change Pod labels, Deployment selectors or Service selectors.
The chart reserves `helm.sh/chart`, `app.kubernetes.io/name`,
`app.kubernetes.io/instance`, `app.kubernetes.io/managed-by`,
`app.kubernetes.io/version` and `app.kubernetes.io/component`; rendering fails if
`additionalLabels` contains any of these keys or a non-string value.

When the chart-managed Secret renders, changing these labels changes its template
checksum on every Deployment's Pod template and triggers a rollout. Without that
Secret, changing these labels does not change the Pod templates.

## Images

There is deliberately no default image tag. Build both images from the same
checked-out QM revision that supplies this chart, or independently verify a
release's core image serves the public front door on `PUBLIC_PORT` and the
`/readyz` endpoint. Images from before the front door moved into core are not
compatible. The chart version is **not** an
application image version.

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
- `publicUrl`, the public HTTPS origin core's front door derives its sign-in and web
  URLs from; rendering fails without it. Plain HTTP works only for a loopback
  address such as `http://localhost:8000`.
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
`env` or `services.core.env`, since those entries would override a potentially
narrower policy in an external Secret. Set OIDC explicitly in values or the external
Secret, including when mixing auth values with `envFrom`. Without `envFrom`, auth
allowlists in `env` or `services.core.env` propagate unless explicit OIDC values
in `env`, `services.core.env` or `secretEnv` override them. Auth allowlists in `secretEnv` are aliased
inside the chart-managed Secret; later `envFrom` sources retain their precedence.

The ingress routes every host to core's public front door port. Core's API port and
the egress proxy stay cluster-internal.

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
  hosts: [qm.example.com]
  className: nginx
  clusterIssuer: letsencrypt-prod
services:
  core:
    replicas: 2
    env:
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
with `SNAPSHOT_STORE=s3`, `TRANSFER_STORE=s3`, `S3_BUCKET`
and `S3_REGION` (optionally `S3_PREFIX`) on core, use a remote `SANDBOX_BACKEND`,
and leave `services.core.persistence` disabled. Sessions and runs then live in
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

`services.<name>.port` controls the process, Service and probes, and
`services.core.publicPort` controls core's front door listener and its Service port;
conflicting `PORT` or `PUBLIC_PORT` values are rejected, as is a front door port equal
to the API port. The egress-proxy image's Envoy listener is fixed at
48080, so other proxy ports are rejected rather than rendered as broken Services.

Core liveness uses `healthPath: /healthz`; readiness uses
`readinessPath: /readyz`. Its startup probe allows five minutes for initialization
before liveness begins. Override `startupProbe` fields as needed, or set it to null
to disable. Helm merges probe maps, so set `startupProbe.httpGet: null` when
switching to an `exec` or `tcpSocket` handler. When overriding endpoint paths,
update the startup probe too. Database unavailability should remove core from
endpoints, not restart it through liveness.

Core's `terminationGracePeriodSeconds` is its shutdown drain plus 30 seconds,
taken from `SHUTDOWN_DRAIN_MS` in `services.core.env` or `env` (default 30000, so
60 seconds). The chart cannot read a drain set through `secretEnv` or `envFrom`;
set it in `env` so the pod is not killed mid-drain.

## Upgrading from chart 0.3

Chart 0.4 runs the web UI, the sign-in portal and the sign-in broker inside
core. Before the first `helm upgrade` to 0.4:

1. Delete the `services.web-ui`, `services.portal` and `services.auth` blocks
   from your values; rendering fails while any of them remains. Move settings
   from `services.portal.env` and `services.auth.env` to `services.core.env`.
2. Replace `services.auth.enabled` with the top-level `auth.enabled`.
3. Delete `ingress.service`. The ingress always routes to core's front door
   (`services.core.publicPort`); core's API port stays inside the cluster.
4. With `auth.enabled: true` the chart sets `AUTH_CLIENT_ID` and
   `OIDC_CLIENT_ID` itself and overrides any other value. With
   `auth.enabled: false`, set `OIDC_CLIENT_ID`; `AUTH_CLIENT_ID` is no longer
   copied into it.
5. Build and push the core image from the new source. The web-ui and portal
   images are no longer used.

The upgrade signs every user out once. The public URL can fail for about ten
seconds while the ingress moves to core's front door before the new core pod is
ready. `helm rollback` to the 0.3 revision restores the old workloads and signs
users out again.

## Regression tests

Install Helm 3 on PATH (or set `HELM_BIN`) and run:

```bash
node --test test/helm-chart.test.ts
```

These tests render real manifests and parse them with Helm's YAML parser. Missing
Helm is a local skip and a CI failure. They do not replace live Kubernetes tests.
