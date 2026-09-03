# Porter deployment

Use this after the choices and billing confirmation in `deployment.md`. Porter
has no `qm` CLI target: `setup`, `plan`, and `up` do not drive it. The flow is
the Porter CLI plus the repo's `porter/apps/` templates, with `docs/porter.md`
as the reference for every failure mode named below.

## Preflight

Install the [Porter CLI](https://docs.porter.run/cli/installation) and prefer
it over raw API calls wherever a command exists. On Homebrew that means the
`porter-dev` tap — Homebrew core's `porter` is an unrelated tool — and
`docker-credential-porter` is a separate binary the tap does not install
(fetch it from Porter's releases and verify the checksum). Require Docker
Buildx too — every image must be built `--platform linux/amd64`:

```bash
porter auth login
porter config set-project <project-id>
docker buildx version
```

Three dashboard steps come before any cluster, in this order. Do them through
the operator's browser when you have browser access; otherwise give the
operator the exact URL and wait:

1. **Cloud account.** A cloud account must be linked to the Porter project at
   <https://dashboard.porter.run/cloud-accounts>. Check before prompting: with
   a token, `GET <PORTER_DEPLOY_URL>/api/v2/alpha/projects/<project>/cloud-accounts`
   lists linked accounts and their connection state. If none is connected, the
   operator links one themselves — the flow grants Porter IAM roles via a
   CloudFormation stack (or the Azure/GCP equivalent) in their own cloud
   console, and no agent should drive that unattended. Field gotchas: the AWS
   quick-create link opens in `us-east-2`, so a region-pinning SCP fails the
   stack with an explicit deny (reopen the same URL under the permitted
   region), and the account ID Porter wants is the one in the AWS console's
   top-right menu, not whatever the operator's CLI is logged into.
2. **Admin API token.** Mint an **Admin-role** token under Settings → API
   tokens and record `PORTER_DEPLOY_PROJECT_ID` and `PORTER_DEPLOY_CLUSTER_ID`.
   A Developer token survives every read and then dies mid-deployment with
   `PERMISSION_DENIED`, and cannot delete clusters — check the role before
   provisioning anything the operator will later need to remove.
3. **Cluster contract.** Create the cluster with the sandbox load balancer,
   `sandboxesEnabled`, and the apps root domain already in the creation
   contract (`docs/porter.md` → "Giving published apps stable hostnames").
   Attaching them after creation is the wedged-cluster path.

## Provision Postgres before first boot

Sign-in hard-requires a durable store: the auth broker's single-use claim
endpoint lives on core's database, so without `DATABASE_URL` the instance
boots and then refuses every sign-in. Porter has no `qm`-CLI database
provisioning — create a datastore in the dashboard's Datastores tab or run
in-cluster Postgres. An API-created datastore can report your cluster in
`connected_cluster_ids` while its security group still refuses connections;
verify with a `psql` from a pod before booting, and prefer in-cluster
Postgres when in doubt.

## Configure the administrator before first boot

The workflow's step 1 collected the administrator's email; on Porter nothing
derives the env vars from it, so set them by hand on core before the first
apply:

```bash
ADMIN_GRANTS=<email>:org_admin
AUTH_ALLOWED_EMAILS=<email>
```

With Postgres and no `ADMIN_GRANTS`, the instance boots, sign-in works, and
the admin console is permanently unreachable — there is no in-product way to
grant the first admin afterwards. The Helm chart bridges `AUTH_ALLOWED_EMAILS`
to the portal's `OIDC_ALLOWED_EMAILS`; on the raw `porter/apps/` path set both.

## Build, deploy, verify

```bash
for f in porter/apps/*.yaml; do porter apply -f "$f"; done
```

Push images only to repositories that already exist — ECR does not create
them on push. In the v2 app YAML, `env` belongs at the app level; nested
under a service it is silently dropped. Apply runs once per app file, twice
overall — assigned hostnames land on the second pass. Then hand-wire the six
service URLs per the table in `docs/porter.md` ("Hosting the qm surfaces"),
push secrets as Porter env groups, and verify by signing in as the
administrator and opening the Admin tab. Published-app serving needs nothing further: apps are reachable
signed-in at `/d/<app>/`; setting `DEPLOY_APPS_DOMAIN` upgrades them to
per-app subdomains (`docs/porter.md`, onboarding checklist).
