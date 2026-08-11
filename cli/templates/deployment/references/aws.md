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
