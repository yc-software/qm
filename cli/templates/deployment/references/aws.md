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

The account must permit the selected RDS class and backup retention in the
configured region and account plan. Set `aws.dbInstanceClass` before
`qm infra render` to override the `db.t4g.small` default. Set
`db_backup_retention_days` in `infra/terraform.tfvars` to override the 35-day
retention default. `aws.dbRetentionMinDays` only sets the minimum that `qm up`
accepts during its restore-point check and does not configure RDS.
Confirm all other billable AWS resources separately; this deployment does not
promise whole-stack free-tier compatibility.

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

## Upgrade an existing stack

Upgrading the CLI does not update a deployment's vendored Terraform, and `qm`
refuses to render or deploy until `infra/` carries the current scaffold.
Preserve local Terraform and tfvars customizations, then replace
`infra/main.tf` and `infra/variables.tf` with the current scaffold.

A stack created before core served the web UI and sign-in itself runs separate
`web-ui` and `portal` ECS services, with portal behind the ALB's `/*` rule.
Terraform drains a service before it deletes that service's listener rule, so a
plain apply leaves the public URL without a healthy target for minutes. Move
the public URL to core without that gap:

1. Remove `"web-ui"` and `"portal"` from `services` and `aws.services`, move
   their `env` and `secretEnv` settings into `core`, and run
   `npm exec qm -- infra render`.
2. Run `npm exec qm -- secrets push` and `npm exec qm -- up --yes`. Core now
   also serves the front door on port 8000 while portal keeps answering the
   public URL.
3. Record portal's listener rule ARN and target group ARNs with
   `terraform -chdir=infra state show` for the addresses below, then remove
   portal's serving resources from Terraform state so the next apply leaves
   portal running:

   ```bash
   terraform -chdir=infra state rm \
     'aws_ecs_service.service["portal"]' \
     'aws_lb_listener_rule.production["portal"]' \
     'aws_lb_target_group.service["portal"]' \
     'aws_lb_target_group.alternate["portal"]' \
     'aws_cloudwatch_log_group.service["portal"]' \
     'aws_ecr_repository.service["portal"]'
   ```

4. Delete the web-ui image repository, which Terraform cannot remove while it
   holds images, then apply the full plan. It attaches core to its front-door
   target group and removes the `web-ui` service. Wait until
   `npm exec qm -- status` reports core stable:

   ```bash
   aws --profile <profile> --region <region> ecr delete-repository --force \
     --repository-name <web-ui-ecr-repository>
   terraform -chdir=infra plan -out=qm.tfplan
   terraform -chdir=infra apply qm.tfplan
   ```

5. Delete portal's listener rule. The public URL falls through to core's `/*`
   rule at once. Then delete the rest of portal:

   ```bash
   aws --profile <profile> --region <region> elbv2 delete-rule --rule-arn <portal-rule-arn>
   aws --profile <profile> --region <region> ecs delete-service --force \
     --cluster <cluster> --service <portal-ecs-service>
   aws --profile <profile> --region <region> ecs wait services-inactive \
     --cluster <cluster> --services <portal-ecs-service>
   aws --profile <profile> --region <region> elbv2 delete-target-group --target-group-arn <portal-target-group-arn>
   aws --profile <profile> --region <region> elbv2 delete-target-group --target-group-arn <portal-alternate-target-group-arn>
   aws --profile <profile> --region <region> logs delete-log-group --log-group-name /ecs/<portal-ecs-service>
   aws --profile <profile> --region <region> ecr delete-repository --force \
     --repository-name <portal-ecr-repository>
   ```

6. Confirm `terraform -chdir=infra plan` reports no changes, then run
   `npm exec qm -- doctor` and `npm exec qm -- check --live`.

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
