# Running qm on Porter

[Porter](https://porter.run) provisions and manages a Kubernetes cluster inside your own
AWS, GCP, or Azure account. qm can use it two ways, independently:

- `SANDBOX_BACKEND=porter` — every agent computer is a Porter sandbox with a persistent
  home volume.
- `DEPLOY_PROVIDER=porter` — apps the agent publishes run on the same cluster.

Both need a Porter API token and the project and cluster that own the sandbox API:

```bash
PORTER_DEPLOY_API_TOKEN=<api token from Settings -> API tokens>
PORTER_DEPLOY_PROJECT_ID=<project id>
PORTER_DEPLOY_CLUSTER_ID=<cluster id>
```

## Hosting the qm surfaces

`porter/apps/` declares the six services (core, auth, web-ui, admin, portal,
egress-proxy) as one Porter app per file, built from `deploy/*/Dockerfile` — `porter
apply` takes exactly one app per invocation and silently ignores extra YAML documents,
which is why they are separate files:

```bash
for f in porter/apps/*.yaml; do porter apply -f "$f"; done
```

Porter runs the services and assigns each **public** web service an `onporter.run`
hostname with a Let's Encrypt certificate, so this path needs no DNS record, no TLS
certificate, and no ingress controller. Only the portal is meant to be Internet-facing;
core, auth, web-ui, and admin carry `private: true` so Porter creates no ingress for them
and they are reachable only at their in-cluster address.

Two things `porter apply` will not do for you:

- **Building on an Apple Silicon machine fails.** `build.method: docker` builds locally
  for `linux/amd64` and the legacy builder cannot cross-compile: the apply dies with
  `image ... does not provide the specified platform (linux/amd64)`. Build and push with
  `docker buildx build --platform linux/amd64 --push` to the registry Porter already
  connected for the project (`porter registry list` prints it), then point the app at the
  pushed image with an `image: {repository, tag}` block. `porter apply --remote` builds
  server-side but is an opt-in project feature and fails with `remote build is not
enabled for this project` until Porter enables it.
- **Env groups created by `porter env create` are not visible to `porter apply`.** Both
  the `envGroups:` key and `--attach-env-groups` fail with `internal: unable to find
latest environment with provided name`, because `porter env create` makes a
  project-scoped group and apply resolves cluster-scoped ones. Put non-secret wiring in
  the app's `env:` block and pass secrets with `--secrets KEY=value` (note that pflag
  splits those on commas, so a JSON value like `AUTH_SIGNING_JWK` has to go in `env:`).

Nothing generates the inter-service wiring for you — `cli/src/services.ts` has `fly` and
`docker` targets but no Porter one — so set it by hand on each app:

| Service      | Wiring                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all          | `CORE_ORG_ID`/`ORG_ID`, `CORE_SIGNING_SECRET`, `PORTAL_IDENTITY_SECRET`                                                                                                                                                                                                                                                                           |
| all but core | `CORE_API_URL=http://qm-core-core.<namespace>.svc.cluster.local:8080`                                                                                                                                                                                                                                                                             |
| core         | `MODEL_PROVIDER`, `HARNESS`, `SANDBOX_BACKEND`, `PUBLIC_WEB_URL`/`WEB_UI_PUBLIC_URL` (the portal's hostname), `CAPABILITY_SECRET`, `CONNECTOR_SECRET_KEY`, `SKILL_SIGNING_SECRET`, and `DATABASE_URL` when `SESSION_STORE`/`RUN_STORE` are `postgres`                                                                                             |
| portal       | `PORTAL_PUBLIC_URL`, `PORTAL_SESSION_SECRET`, `WEB_UI_UPSTREAM`, `ADMIN_UPSTREAM`, `AUTH_BROKER_UPSTREAM`, `AUTH_BROKER_PREFIX=/idp`, the `OIDC_*` set from `brokerWiring` in `cli/src/services.ts` (including `OIDC_CLIENT_SECRET`), and `OIDC_ALLOWED_EMAILS` or `OIDC_ALLOWED_EMAIL_DOMAIN` — production refuses to boot without an allow-list |
| admin        | `ADMIN_BASE_PATH=/admin`                                                                                                                                                                                                                                                                                                                          |
| auth         | `AUTH_ISSUER=<portal>/idp`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_REDIRECT_URI=<portal>/auth/callback`, `AUTH_TOKEN_SECRET`, `AUTH_SIGNING_JWK` (a P-256 private JWK), `AUTH_EMAIL_FROM`, and `AUTH_EMAIL_TRANSPORT` with a `RESEND_API_KEY` or SMTP credentials — without a mail transport nobody can sign in                            |

`src/deployment/secret-schema.ts` is the authoritative list of what each service
requires; when a boot refusal names a variable this table doesn't, that file is the place
to look.

The portal's hostname is only knowable after its first apply, and core, portal, and auth
all need it, so expect to apply twice: once to mint the hostname, once to wire it in. The
CLI does not print the assigned hostname — read it from the app's page in the dashboard,
or from the ingress itself: `porter kubectl --print-kubeconfig` writes a short-lived
kubeconfig, and `kubectl get ingress` lists every assigned host.

Porter's own Postgres datastores are created from the dashboard. An RDS instance in the
cluster's VPC works too, but Postgres 17 defaults to `rds.force_ssl=1`, so the URL needs
`?sslmode=no-verify` (or a CA pinned with `DATABASE_CA_CERT`) or core dies on `no pg_hba.conf
entry ... no encryption`.

`deploy/helm/` carries the same topology as a Helm chart for operators who would rather
manage the release themselves; it expects the images published at
`ghcr.io/yc-software/qm/<service>` and an ingress you configure. Pin `image.tag` to a
commit that actually carries the Porter backend — the published tags are commit SHAs, and
one from before Porter support landed rejects `SANDBOX_BACKEND=porter` at startup. Set
`publicUrl` and the chart derives the broker wiring (`AUTH_ISSUER`, `AUTH_REDIRECT_URI`
and the portal's `OIDC_*` endpoints) the way `cli/src/services.ts` does for the other
targets; what it cannot invent is the identity allow-list, so production still refuses to
boot until `AUTH_ALLOWED_EMAILS`/`AUTH_ALLOWED_EMAIL_DOMAIN` is set, and the auth broker
needs a real mail transport (`RESEND_API_KEY` or the `SMTP_*` set) because there is no
console transport. `SANDBOX_BACKEND` has no default and core refuses to start in
production without it.

`porter kubectl --print-kubeconfig` is enough to read a Porter cluster but not to install
into one: the kubeconfig it prints authenticates as `porter-readonly-sa-customer`, which
holds `get`/`list`/`watch` and nothing else, so `helm install` fails on the first write. On
EKS, grant yourself real access through AWS instead — `aws eks update-cluster-config
--access-config authenticationMode=API_AND_CONFIG_MAP`, then an access entry for your own
principal with `AmazonEKSClusterAdminPolicy`, then `aws eks update-kubeconfig`.

## Giving published apps stable hostnames

Published apps get their address from the cluster, not from qm. Declare the sandbox load
balancer with a root domain at cluster creation and **Porter names every published app
itself**: `<app>.<root domain>`, served on a wildcard Let's Encrypt certificate that Porter
also obtains. `PORTER_DEPLOY_APPS_DOMAIN` is then only for choosing a different name — leave
it unset and the cluster-assigned hostname is used as-is. Set it when the cluster serves
more than one apps domain, or when you want a name other than the cluster's own root domain;
it has to resolve to the same sandbox ingress either way.

The address comes from Porter's **sandbox ingress**, which is separate from the ingress
that serves Porter apps and is configured per cluster. A cluster without it rejects every
publish before DNS is ever consulted, with `HTTP 400: validation error: visibility: no
private sandbox ingress is configured on this cluster` (`no public sandbox ingress` when
`PORTER_DEPLOY_VISIBILITY=public`). A cluster that has it but no root domain names no host,
and the deploy fails after the body is created (the body is then retired, so nothing leaks).

The dashboard has a toggle for it, but it is also a plain field on the cluster contract,
so it can be turned on headlessly. `GET /api/projects/<project>/contracts` returns the
revisions for the project, newest last, each with a `base64_contract`; decode the current
one, add the sandbox load balancer, and `POST` the whole contract back to
`/api/projects/<project>/contract` (singular, raw protojson — not base64, not wrapped):

```json
{
  "kind": "LOAD_BALANCER_KIND_NLB",
  "owner": "LOAD_BALANCER_OWNER_SANDBOX",
  "networkAccess": "NETWORK_ACCESS_PUBLIC",
  "dnsProviderConfig": { "provider": "DNS_PROVIDER_TYPE_ROUTE53", "route53Domain": "" },
  "rootDomains": ["apps.example.com"],
  "waf": { "enabled": false }
}
```

appended to `cluster.additionalLoadBalancers`, alongside `cluster.eksKind.sandboxesEnabled:
true`. Route53 authenticates through the cluster's own pod identity and needs no token;
`DNS_PROVIDER_TYPE_CLOUDFLARE` needs one stored first at `POST
/api/v2/projects/<project>/clusters/<cluster>/dns/credentials`. The same route creates a
cluster in the first place — omit `cluster.clusterId` and Porter provisions a new one.

Note where that array hangs: `additionalLoadBalancers` is a field of `cluster`, a sibling of
`eksKind`, while `sandboxesEnabled` is inside `eksKind`. Putting the load balancer in the
obvious-looking spot next to `sandboxesEnabled` does not fail — Porter parses the contract
with unknown fields discarded, so a misplaced or misspelled key is dropped in silence and
the POST still answers `201` with a revision id. The cluster then provisions with no sandbox
ingress and the mistake only surfaces 40 minutes later, when the first publish is refused.
**Always read the contract back after submitting it** and confirm the fields you set are
actually there:

```bash
curl -s -H "Authorization: Bearer $PORTER_DEPLOY_API_TOKEN" \
  https://dashboard.porter.run/api/projects/<project>/contracts |
  jq -r '.[] | select(.cluster_id==<cluster>) | .base64_contract' | tail -1 | base64 -d | jq .
```

The same silent-drop rule makes the contract useless for guessing at fields the schema may
not have: an invented key and a real one are equally accepted. To test whether a field
exists, send it together with a deliberate control key that certainly is not a field, then
read back and compare which of the two survived.

Put the sandbox load balancer in the contract you create the cluster with, and treat every
later revision as a one-at-a-time operation: **submit a revision only when the cluster
reads `READY`, and let it finish.** A revision submitted while another is reconciling
supersedes it. The interrupted one stops with `CONCURRENT_UPDATE` ("contract revision
is obsolete, and has been acked") and the newer one carries on, so the cluster returns to
`READY` or `FAILED` once that newer revision completes. While it reconciles, Porter refuses
a further contract with `cluster status forbids updating` and a delete with `unable to
delete cluster that is updating`. Wait it out.

Do not delete a revision to cancel it. `DELETE /api/projects/<project>/contracts/<revision
id>` answers 200, but it removes the record the reconciler is working from, and a cluster
whose in-flight revision disappears is the one that stays in `UPDATING` with nothing left
to finish it. If a cluster shows `UPDATING` and its newest revision is not changing, ask
Porter support; resetting the status takes them seconds.

Do not tear down a Porter cluster's AWS resources by hand, and do not edit the trust
policies on `porter-manager` or `porter-access-manager`. Porter's Cluster API controllers
rebuild whatever is missing while the cluster exists. Revoking the trust does not stop
that cleanly. It also cuts off the delete path, so Porter can no longer reach the account
to remove anything, and the cluster is left half torn down in both systems. The only
supported teardown is the cluster delete described in [Deleting a cluster](#deleting-a-cluster).

Deleting a cluster through the API needs an admin-role Porter token: `DELETE
/api/projects/<project>/clusters/<cluster>` answers a project API token with `403
{"error":"insufficient permissions to perform action"}` even when that token may create
clusters. Check that you hold one before you provision anything you will need to remove.

The same status gate makes the contract endpoint useless for schema discovery on a busy
cluster. Porter resolves the cluster and checks its status _before_ it parses the protojson
body, so an unknown field and a well-formed one come back with the identical `cluster status
forbids updating`, and a nonexistent `clusterId` returns `sql: no rows in result set` just
as uniformly. Probing for whether a contract field exists needs a `READY` cluster.
Once the revision reconciles, `GET
/api/v2/projects/<project>/clusters/<cluster>/load-balancers` returns the new
`owner: "sandbox"` entry whose `address.value` is the sandbox load balancer's hostname.

**You create the DNS zone; Porter creates the certificate.** With
`DNS_PROVIDER_TYPE_ROUTE53`, Porter looks in the cluster's AWS account for a _public_
hosted zone named exactly the root domain (`apps.example.com`, not `example.com`). A parent
zone is rejected on purpose, because scoping cert-manager's credentials to it would grant
write access beyond the subdomain, and the cluster's system applications stop at
cert-manager with `no public route53 hosted zone for "apps.example.com" ... create a
delegated hosted zone`. The zone has to be public even when the sandbox ingress is
private, because Let's Encrypt validates the DNS-01 challenge over the public internet.
Set it up before you create the cluster, or before you add the root domain to it:

1. Create a public hosted zone named exactly the root domain, in the same AWS account as
   the cluster.
2. In the parent zone, add an `NS` record for the root domain with the four name servers
   Route53 assigned to the new zone.
3. Once the cluster is `READY`, read the sandbox load balancer's hostname from the
   `load-balancers` endpoint above and add `*.<root domain>` **in the new zone** as an
   alias `A` record pointing at it. A `CNAME` works too, but an alias `A` record is how
   Route53 expects to point at a load balancer.

Porter's own docs cover the same steps for Route53 and Cloudflare:
https://docs.porter.run/sandboxes/networking#configure-networking-on-the-cluster.

From there Porter does the rest. It mints a per-cluster role
`porter-cert-manager-route53-<cluster id>` whose inline policy allows
`route53:ChangeResourceRecordSets` and `ListResourceRecordSets` on that one zone, plus
`GetChange` and `ListHostedZonesByName`. It attaches that role to cert-manager through EKS
pod identity. cert-manager then issues a real Let's Encrypt `*.<root domain>` certificate
that ordinary clients verify with no `-k`. If TLS is not issuing, check that this role
exists before looking at cert-manager itself.

The zone and the `NS` record are yours and outlive the cluster. Remove them when you
retire the domain, and reuse them for the next cluster that carries the same root domain;
only the wildcard record needs repointing at the new load balancer.

The failure signature when the zone is missing or wrong: the cluster sits in `UPDATING`
(`UPDATING_UNAVAILABLE` on first creation) for up to two hours and then flips to `FAILED`
with `RETRYING_TOO_LONG`. Fix the zone, submit the contract again (the dashboard's
**Retry** button does this), and the install completes within a few minutes. A cluster
that did reach `READY` but serves nginx's self-signed _Kubernetes Ingress Controller Fake
Certificate_ has a zone problem of the other kind, usually a wildcard record that lives in
the parent zone instead of the delegated one. `kubectl get certificate -n porter-sandbox`
shows whether the certificate ever issued.

Naming the domain is optional. Porter assigns every sandbox that exposes a port a hostname
of its own, `<sandbox name>.<cluster root domain>`, whether or not the create request asked
for a domain — sending `networking: [{port: 8080}]` with no `domains` key, or with
`domains: []`, both come back with a populated `host`. So a cluster whose sandbox load
balancer carries a root domain publishes apps at a working HTTPS address with nothing set:

```bash
PORTER_DEPLOY_APPS_DOMAIN=apps.example.com   # optional; overrides the assigned hostname
```

Set it only to choose the name yourself; the wildcard record it relies on is the one Porter
already created. Deployments are **private** by default, matching the other providers;
`PORTER_DEPLOY_VISIBILITY=public` opts a deployment's domain into public ingress.

## Deleting a cluster

Delete a cluster through Porter, never through AWS. The dashboard's delete button starts
the same job as `DELETE /api/projects/<project>/clusters/<cluster>` (admin token, see
above). Everything below then happens on its own:

1. The cluster is marked `DELETING`. A cluster in `UPDATING` or `UPDATING_UNAVAILABLE` is
   refused instead; wait for the revision to finish first.
2. Porter removes the ingress load balancers, then deletes the Karpenter `NodePool` and
   `EC2NodeClass` resources and waits for every node they own to drain and terminate. It
   then removes the Karpenter interruption queue and EventBridge rules.
3. Porter's Cluster API controllers delete the EKS cluster and the VPC and node groups
   they created for it.
4. The cluster is marked `DELETED`. Fifteen to twenty minutes is normal for an idle
   cluster.

The delete loop never times out. If the cluster is still `DELETING` after half an hour,
something in step 2 is refusing to go away, and that is almost always still on your side:

- Running sandboxes. A sandbox pins its node, so Karpenter cannot drain it and the
  `NodePool` never finalizes. Stop every sandbox on the cluster before deleting it
  (`porter sandbox list`, or the dashboard's Sandbox tab) and give the daemon a minute to
  release the nodes. Published apps are sandboxes too.
- Anything else that blocks eviction: a `PodDisruptionBudget` with no headroom, a pod
  carrying the `karpenter.sh/do-not-disrupt` annotation, or a stuck finalizer.
  `porter kubectl -- get nodeclaims` shows what Karpenter is still waiting on, and
  `porter kubectl -- describe nodeclaim <name>` says why.
- Load balancers or ingresses you created yourself in the cluster. Porter only removes
  its own.

Things that do not help, and make it worse:

- Deleting the EKS cluster or its VPC yourself in AWS. Porter's delete then
  fails on every pass because the cluster it is trying to drain no longer answers, and it
  cannot finish until someone at Porter clears the leftover Cluster API record.
- Editing the trust policies on `porter-manager` or `porter-access-manager`. That cuts
  Porter off from the account entirely, including the delete you are waiting on.
- Deleting the contract revision, for the reason given above.

If you have cleared the blockers and it is still stuck, send the cluster id to Porter
support. They can see exactly which step is looping.

## Forcing sandbox egress through the proxy

`PORTER_SANDBOX_EGRESS_PROXY_URL` makes core pass `egress.allowed_destinations: [<proxy
host>]` when it creates a sandbox, and inject `HTTPS_PROXY`/`HTTP_PROXY` pointing at the
proxy with a capability token as the password. Two cluster-side facts decide whether that
works at all, and both fail in ways that do not name the real cause:

- **The cluster must have egress restriction turned on.** Without it Porter rejects the
  create outright — `HTTP 400: validation error: egress: egress restriction is not
available on this cluster` — so the agent ends up with no computer rather than an
  unrestricted one. It is a per-cluster setting on the `sandbox-api` system application:
  `PATCH /api/v2/projects/<project>/clusters/<cluster>/system-applications/sandbox-api`
  with `{"sandbox_config":{"egress_enabled":true}}`, then `POST
.../trigger-system-application-reconcile` with `{"dry_run":false,
"system_application_name":"sandbox-api"}`. `GET` on the same path reads it back, and
  turning it on installs Cilium, which enforces the allowlist. There is no contract field
  for any of this — the cluster contract carries no egress key at all, so it cannot be set
  at creation time and this PATCH is the only route. The call is gated on the token's role,
  not on being a human: a Developer-role API token is refused with `PERMISSION_DENIED` even
  though it may create clusters, while an **Admin-role API token** (Settings → API tokens)
  is accepted. Minting an admin token is enough; no dashboard session is required. The same
  distinction governs `DELETE /api/projects/<project>/clusters/<cluster>`, which answers a
  Developer token with `403 insufficient permissions to perform action`.
- **The proxy has to be reachable from outside the cluster.** Porter attaches a
  NetworkPolicy to every sandbox that permits DNS plus `0.0.0.0/0` _except_ `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` and `100.64.0.0/10` — every RFC1918
  range, which is where both the pod and service CIDRs live. A sandbox therefore cannot
  reach an in-cluster Service, so a `*.svc.cluster.local` proxy URL times out with no
  error worth reading. Give the proxy an internet-reachable address (a `LoadBalancer`
  Service in front of it is enough) and point `PORTER_SANDBOX_EGRESS_PROXY_URL` there.
  This is also why `deploy/helm/`'s `egress-proxy` service cannot serve Porter sandboxes
  as-is: it is a ClusterIP worker.

The proxy itself runs fine unprivileged, but `deploy/egress-proxy` wants `NET_ADMIN` to
install the iptables rule that blocks the cloud metadata endpoint. Without the capability
it logs `could not install metadata firewall ... NET_ADMIN missing?` and keeps serving, so
grep for that line rather than assuming the container's own metadata block is in place.

## Other knobs

| Variable                                           | Meaning                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PORTER_DEPLOY_URL`                                | Porter API host, when it isn't `https://dashboard.porter.run`                                                  |
| `PORTER_SANDBOX_IMAGE`                             | Image agent computers boot from                                                                                |
| `PORTER_DEPLOY_RUNNER_IMAGE`                       | Image published apps boot from (defaults to the sandbox image)                                                 |
| `PORTER_SANDBOX_EGRESS_PROXY_URL`                  | Forces sandbox traffic through the egress proxy; unset means no egress enforcement (see the constraints below) |
| `PORTER_SANDBOX_NAME_PREFIX`                       | Prefix for sandbox and app names on the cluster                                                                |
| `PORTER_DEPLOY_VISIBILITY`                         | `public` puts a published app on public ingress; default is private                                            |
| `PORTER_DEPLOY_TTL_SEC` / `PORTER_SANDBOX_TTL_SEC` | Reap bodies after this long                                                                                    |

To QA a branch against a real Porter cluster before deploying it, the dev instance takes
the same backend:

```bash
bash scripts/dev-instance.sh up --sandbox porter
```
