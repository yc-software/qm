# AWS deployment

Use this after the choices and billing confirmation in `deployment.md`.
Terraform state, credentials, and every resource must belong to the operator.

## Preflight

Require Terraform, Docker, authenticated AWS credentials, two available AZs,
and AWS CLI support for Lambda MicroVMs:

```bash
aws --profile <profile> sts get-caller-identity
aws --profile <profile> ec2 describe-availability-zones --region <region> \
  --filters Name=state,Values=available
aws --profile <profile> lambda-microvms list-microvm-images --region <region>
terraform version
docker buildx version
```

If Lambda MicroVMs are unavailable, stop before mutation and offer Fly.io. Set
the account, region, service coordinates, and an operator-owned GitHub
repository and exact branch in the generated config and Terraform variables.
Never trust the upstream QM repository.

Configure a private encrypted Terraform backend, then:

```bash
npm exec qm -- infra render
terraform -chdir=infra init
terraform -chdir=infra plan -out=qm.tfplan
terraform -chdir=infra apply qm.tfplan
```

Set `publicUrl`, `env.core.AWS_PUBLIC_ORIGIN_URL`, and `aws.deployRoleArn` from
the Terraform outputs. Finish `npm exec qm -- setup .`, render again, and apply.

New directories scaffolded by the current CLI protect the object-store bucket
from replacement and reject the placeholder account. Upgrading the CLI does not
rewrite vendored `infra/` files in an existing deployment. Do not overwrite
customized Terraform templates to gain these guards.

For an existing deployment, first pin its current bucket name before changing
`aws.accountId`, `aws.region`, or `aws.cluster`:

```bash
terraform -chdir=infra output -raw object_store_bucket
```

Copy that exact value to `aws.objectStoreBucket` in `qm.config.jsonc`. Do not
infer the name from corrected coordinates. Before rendering, make the minimal
manual update by adding this block inside the existing
`aws_s3_bucket.objects` resource:

```hcl
lifecycle { prevent_destroy = true }
```

To reject the scaffold account at Terraform plan time, add this validation
inside the existing `variable "account_id"` block:

```hcl
validation {
  condition     = var.account_id != "000000000000"
  error_message = "account_id must replace the scaffold value 000000000000 before planning or applying infrastructure"
}
```

After the bucket is pinned and both Terraform guards are present, correct
`aws.accountId` and related account-derived coordinates such as
`aws.deployRoleArn`. Then run `npm exec qm -- infra render` and verify the plan
does not replace `aws_s3_bucket.objects` or any other unintended resource. Pin
the existing bucket first, but do not render until after correcting the
placeholder account.

Pinning and `prevent_destroy` are the controls that protect the existing
bucket. `object_store_force_destroy=true` only allows
Terraform to delete objects when intentionally deleting a bucket; it does not
override `prevent_destroy`. For intentional deletion, retain any agent files
that must survive, deliberately remove `prevent_destroy`, apply the
`object_store_force_destroy` setting, and then destroy as described in the
generated `AGENTS.md`.

## Publish the agent computer and deploy

```bash
npm exec qm -- infra build-image
npm exec qm -- check
npm exec qm -- secrets push
npm exec qm -- doctor
npm exec qm -- plan
npm exec qm -- up --yes
npm exec qm -- check --live
```

Existing deployments created before private session canaries must rerun
`npm exec qm -- infra render`, review the Terraform plan, and apply it with
infrastructure-administrator credentials before enabling `check --live`. This
adds the deploy role's stack-scoped permission to run and inspect the one-off
core canary task.

The package image manifest supplies first-party control-plane images. The AWS
backend transfers them into deployment-owned ECR and records immutable digests.
After the first successful deployment, rerun `npm exec qm -- up --yes` and
confirm it reconciles the same stack.

## Agent-computer proof

Copy the exact personal scope id shown for the signed-in administrator in
Admin, then derive the same opaque storage key as the runtime and read only the
proof file from the deployment-owned S3 home snapshot:

```bash
scope_id='personal:<exact-admin-principal>'
scope_key="$(npm exec qm -- proof scope-key "$scope_id")"
bucket="$(terraform -chdir=infra output -raw object_store_bucket)"
aws --profile <profile> --region <region> s3 cp \
  "s3://$bucket/sandbox-home/$scope_key.tar" - |
  tar -xOf - workspace/qm-computer-proof.txt
```

Require the output to match the UUID created in the browser. A missing or
ambiguous scope, snapshot, or file is a failed proof.

Routine operations:

```bash
npm exec qm -- status
npm exec qm -- logs core --follow
npm exec qm -- rollback --to <release-label-or-manifest-id>
npm exec qm -- down
```

Terraform destroy is separate and destructive. Decide how to retain RDS
snapshots, S3 objects, and secrets before following the generated `AGENTS.md`
teardown section.
