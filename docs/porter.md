# Running qm on Porter

[Porter](https://porter.run) provisions and manages a Kubernetes cluster inside your own
AWS, GCP, or Azure account. qm can use it two ways, independently:

- `SANDBOX_BACKEND=porter` — every agent computer is a Porter sandbox with a persistent
  home volume.
- `DEPLOY_PROVIDER=porter` — apps the agent publishes run on the same cluster.

Both need a Porter API token and the project and cluster that own the sandbox API. The
complete environment for a Porter-backed instance, verified against a live deployment:

```bash
SANDBOX_BACKEND=porter
DEPLOY_PROVIDER=porter
PORTER_DEPLOY_API_TOKEN=<ADMIN-role api token from Settings -> API tokens>
PORTER_DEPLOY_PROJECT_ID=<project id>
PORTER_DEPLOY_CLUSTER_ID=<cluster id>
PORTER_SANDBOX_IMAGE=ghcr.io/porter-dev/qm-sandbox:latest
PORTER_DEPLOY_RUNNER_IMAGE=ghcr.io/porter-dev/qm-app-runner:latest
# PORTER_DEPLOY_URL=            # only when the API host is not https://dashboard.porter.run
# PORTER_DEPLOY_APPS_DOMAIN=    # optional; the cluster names apps itself (see below)
# PORTER_DEPLOY_VISIBILITY=public  # public Porter ingress serves apps to ANYONE with the
                                   # URL, bypassing qm's sign-in gate — leave private and
                                   # use /d/<app>/ or DEPLOY_APPS_DOMAIN unless that is the intent
```

## Onboarding checklist

Everything below this section is reference and field notes; this is the order that
actually gets a new operator from zero to a working instance (the deployment workflow's
agent-facing version lives at `cli/templates/deployment/references/porter.md`). If you are an agent doing
this deployment: install and prefer the `porter` CLI over raw API calls wherever a
command exists ([install instructions](https://docs.porter.run/cli/installation) — on
Homebrew that is the `porter-dev` tap, Homebrew core's `porter` is an unrelated tool, and
`docker-credential-porter` is a separate checksum-verified binary the tap does not
install); use
the operator's browser for the dashboard steps when you have browser access, and
otherwise hand the operator the exact URL and wait — several steps below cannot be done
any other way.

1. **A cloud account must be linked to the Porter project** at
   [dashboard.porter.run/cloud-accounts](https://dashboard.porter.run/cloud-accounts)
   before any cluster can exist. Check first — with a token,
   `GET <PORTER_DEPLOY_URL>/api/v2/alpha/projects/<project>/cloud-accounts` lists linked
   accounts and their connection state; without one, look at the dashboard page. If none
   is connected, the operator has to link one themselves: the flow grants Porter IAM
   roles via a CloudFormation stack (or the Azure/GCP equivalent) in _their_ cloud
   console, which no agent should drive unattended. Two AWS gotchas from the field: the
   quick-create link opens in `us-east-2`, so an org SCP that pins regions makes the
   stack fail with an explicit deny — reopen the same URL under the permitted region —
   and the account ID Porter wants is the one shown in the AWS console's own top-right
   menu, not whatever account the operator's CLI happens to be logged into.
2. **Mint an Admin-role API token** (Settings → API tokens) and record
   `PORTER_DEPLOY_PROJECT_ID` and `PORTER_DEPLOY_CLUSTER_ID`. The role matters: a
   Developer token survives every read until it dies mid-deployment with
   `PERMISSION_DENIED` (details under egress below) and cannot delete clusters. Check
   the role before provisioning anything you will later need to remove.
3. **Create the cluster with the sandbox load balancer in the creation contract** —
   sandbox ingress, `sandboxesEnabled`, and the apps root domain all belong in the
   contract the cluster is born with; attaching them later is the wedged-cluster
   forensics that "Giving published apps stable hostnames" below exists to debug. The
   Route53 hosted zone for the root domain is yours to create either way (dedicated
   zone, `NS` delegation in the parent, wildcard record inside — then reconcile; see
   below), and so is the LoadBalancer in front of the egress proxy ("Forcing sandbox
   egress through the proxy" — without it egress runs fail-open).
4. **Provision Postgres and set `DATABASE_URL` before first boot.** Sign-in is not
   optional here: the auth broker's single-use claim endpoint needs core's durable
   store, so an instance without a database accepts no sign-ins at all. The Porter
   path has no `qm`-CLI database provisioning — create a datastore in the dashboard
   (Datastores tab) or run in-cluster Postgres. A datastore created through the API
   can come back with `connected_cluster_ids` naming your cluster while its security
   group still refuses it — verify with a `psql` from a pod before booting, and
   prefer in-cluster Postgres when in doubt.
5. **Name the administrator before first boot.** Set `ADMIN_GRANTS=<email>:org_admin`
   on core and the sign-in allowlist (`AUTH_ALLOWED_EMAILS=<email>` — the Helm chart
   bridges it to the portal's `OIDC_ALLOWED_EMAILS`). This is the step the old docs
   never mentioned: with Postgres and no `ADMIN_GRANTS`, the instance boots, everyone
   allowed can sign in, and the admin console is permanently unreachable — there is no
   in-product way to grant the first admin afterwards.
6. **Build, push, and apply**: images built `--platform linux/amd64` and pushed to
   repositories that already exist (ECR does not create them on push — create or seed
   each repository first), then
   `for f in porter/apps/*.yaml; do porter apply -f "$f"; done` (twice — the hostname
   lands on the second pass), then wire the service URLs per the table below. In the
   v2 app YAML, `env` belongs at the app level: nested under a service it is silently
   dropped, and the app boots without its configuration. Verify by signing in as the
   admin and opening the Admin tab.

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

Core also reads `RESEND_API_KEY` and `AUTH_EMAIL_FROM` when they are set — optional there,
they let admins email external-user invitations from the admin Users tab or by chatting
with QM.

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

App serving is tiered so the zero-config path works first. With nothing set, every
published app is reachable signed-in at `/d/<app>/` on the portal, private to its owner
and whoever the deployment is shared with; proxied HTML is served under a sandbox CSP so
app code cannot act on the portal's origin. Setting `DEPLOY_APPS_DOMAIN` to a wildcard
domain you control (e.g. `apps.example.com`, with `*.apps.example.com` pointed at the
instance) upgrades every app to its own origin — `https://<app>.apps.example.com/` — with
portal single sign-on, the request-access flow, and live editing; the portal derives its
cookie and returnTo settings from it, and boot probes the wildcard record and prints the
exact DNS record to add when it is missing. Point the wildcard at the ingress that fronts
core, never at Porter's sandbox ingress — the gate runs in core, so DNS that skips core
skips the gate. `PORTER_DEPLOY_APPS_DOMAIN` is the separate, ungated mechanism: it
registers each app's domain on Porter's own sandbox ingress and is deliberately NOT
defaulted from `DEPLOY_APPS_DOMAIN`.

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
supersedes it, and the interrupted one stops with `CONCURRENT_UPDATE` ("contract revision
is obsolete, and has been acked"). That path can strand the cluster in `UPDATING`, and
Porter gates both recovery routes on the status — a new contract is refused with `cluster
status forbids updating` and deletion with `unable to delete cluster that is updating`.
Cancelling the dead revision returns 200 without clearing it, so the cluster has to be
unstuck by Porter support.

A stranded cluster is not idle. Porter's Cluster API controllers keep reconciling it from
Porter's own account, so tearing its AWS resources out by hand does not work: delete the
EKS cluster and the nodes and they are rebuilt within minutes, by
`arn:aws:iam::<account>:role/porter-manager` with a `aws.cluster.x-k8s.io` user agent —
`aws cloudtrail lookup-events --lookup-attributes
AttributeKey=EventName,AttributeValue=CreateCluster` shows the recreate. The reconcile
loop enters the account through one door, so close that first: `porter-manager` and
`porter-access-manager` each trust `arn:aws:iam::108458755588:role/CAPIManagement` under an
external id, and dropping those two statements from their trust policies (`aws iam
update-assume-role-policy`) stops the rebuild immediately. Only then does a manual sweep
hold. **For a wedged cluster the IAM revoke comes first, not last** — the usual teardown
order that leaves IAM until the end cannot terminate.

Deleting a cluster through the API needs an admin-role Porter token: `DELETE
/api/projects/<project>/clusters/<cluster>` answers a project API token with `403
{"error":"insufficient permissions to perform action"}` even when that token may create
clusters. Check that you hold one before you provision anything you will need to remove.

The same status gate makes the contract endpoint useless for schema discovery on a wedged
cluster. Porter resolves the cluster and checks its status _before_ it parses the protojson
body, so an unknown field and a well-formed one come back with the identical `cluster status
forbids updating`, and a nonexistent `clusterId` returns `sql: no rows in result set` just
as uniformly — probing for whether a contract field exists needs a healthy cluster.
Once the revision reconciles, `GET
/api/v2/projects/<project>/clusters/<cluster>/load-balancers` returns the new
`owner: "sandbox"` entry whose `address.value` is what the wildcard record points at.

Routing, DNS and TLS all come up on their own, provided the sandbox load balancer was in
the contract the cluster was created with. Porter reads its `dnsProviderConfig` and
`rootDomains`, but **the hosted zone itself is yours to create** — confirmed against
Porter's team and a live cluster: even with the sandbox load balancer in the creation
contract, Porter never creates the zone, the delegation, or the wildcard record. Create a
dedicated Route53 hosted zone for the root domain, add its `NS` delegation to the parent
zone, put the wildcard record inside it pointing at the sandbox load balancer, then
reconcile the cluster (the dashboard's infra **Update**, or re-POST the contract) so Porter
creates the certificate issuer against the zone. cert-manager's DNS-01 challenge then has a
zone it can write to, and the wildcard certificate issues — a real Let's Encrypt
`*.<root domain>` certificate, verified by ordinary clients with no `-k`. A wildcard CNAME
sitting in the parent zone is not enough: DNS resolves, but there is no delegated zone for
the challenge and the certificate never issues.

Porter also mints the credentials for it: a per-cluster role
`porter-cert-manager-route53-<cluster id>` whose inline policy allows
`route53:ChangeResourceRecordSets` and `ListResourceRecordSets` on that one delegated zone,
plus `GetChange` and `ListHostedZonesByName`. If TLS is not issuing, check that this role
exists — its absence, not a cert-manager misconfiguration, is the usual cause.

Two things follow. The parent zone must be in the same AWS account the cluster runs in.
And **teardown has to remove what you created**: the delegated hosted zone and the `NS`
record in the parent zone both outlive the cluster.

This is worth stating plainly because the failure is so confusing: a cluster whose root
domain was never delegated has no usable zone for the DNS-01 challenge, so the certificate
never issues and the ingress serves nginx's self-signed _Kubernetes Ingress Controller Fake
Certificate_. Every client then fails certificate verification against an app that is
otherwise serving correctly — including the agent's own probe of the app it just published, which is why it
reports a gateway error it cannot explain. `kubectl get certificate -n porter-sandbox` tells
you which situation you are in before you go hunting.

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
`PORTER_DEPLOY_VISIBILITY=public` opts a deployment's domain into public ingress. Note the
cluster-assigned hostname is Porter ingress only — qm's sign-on gate, request-access flow,
and live editing need `DEPLOY_APPS_DOMAIN` (a domain you control, not a shared platform
domain like `onporter.run`).

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
