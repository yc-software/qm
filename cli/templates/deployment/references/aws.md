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

When `apiUrl` names a host other than `publicUrl`'s, or `env.core.DEPLOY_APPS_DOMAIN`
is set, the ALB sends those hosts (the `apiUrl` host and `*.<apps domain>`) by
host-header rules straight to core's API port 8080, so machine callers such as
the egress proxy and sandboxes reach the whole API rather than only the front
door's pass-through paths. The scaffold renders them as `core_public_hosts` and
requires `certificate_arn`. Core's ECS service is attached to two target groups:
the front door on port 8000 (named by `aws.services.core.targetGroup` on
external infrastructure) and the API, found as core's one attachment on
container port 8080. On external infrastructure, the listener default forwards
to the front-door group, plugin `publicPaths` rules come first, and each core
host rule has only a host-header condition and forwards to the API group. `qm up` and `qm check --live` reject
any other rule or target group and wait for healthy targets in both groups.

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

Core's ECS `stopTimeout` defaults to `env.core.SHUTDOWN_DRAIN_MS` (default 30000) plus 30 seconds, so a replaced core task can hand its turns to the new
one before ECS kills it. Fargate allows at most 120 seconds, so keep the drain at
or below 90000 or pin `aws.services.core.stopTimeout`.

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
`qm up` deploys only once the ALB already sends `/*` to core, and Terraform
drains a service before it deletes that service's listener rule. Move the
public URL to core once, by hand, without a gap:

1. Install the current CLI. Remove `"web-ui"` and `"portal"` from `services`
   and `aws.services`, move their `env` and `secretEnv` settings into `core`,
   and run `npm exec qm -- infra render`.
2. Run `npm exec qm -- secrets push`. It restarts core on its current image
   with the new configuration while portal keeps answering the public URL.
3. Build core's new image and apply its migrations:

   ```bash
   npm exec qm -- up --build-only --image-label <label> --candidate-out candidate.json
   npm exec qm -- migrate --candidate candidate.json --yes
   ```

4. Register core's task definition for that image and roll core onto it:

   ```bash
   node --input-type=module -e '
   import { readFileSync, writeFileSync } from "node:fs";
   import { loadConfigAt, renderTaskDefinition } from "@yc-software/qm/contract";
   const { config } = loadConfigAt("qm.config.jsonc");
   const { images } = JSON.parse(readFileSync("candidate.json", "utf8"));
   writeFileSync("core-task.json", JSON.stringify(renderTaskDefinition(config, "core", images.core)));
   '
   aws --profile <profile> --region <region> ecs register-task-definition \
     --cli-input-json file://core-task.json \
     --tags key=ManagedBy,value=qm-cli key=Deployment,value=<orgId> \
     --query taskDefinition.taskDefinitionArn --output text
   aws --profile <profile> --region <region> ecs update-service \
     --cluster <cluster> --service <core-ecs-service> --task-definition <task-definition-arn>
   aws --profile <profile> --region <region> ecs wait services-stable \
     --cluster <cluster> --services <core-ecs-service>
   ```

   A blue/green roll of core can outlast the waiter's 10 minutes. If
   `wait services-stable` exits 255 here or in step 6, run it again.

5. Record the ARNs of portal's listener rule and both portal target groups with
   `terraform -chdir=infra state show`, then remove the retired services from
   Terraform state so the next apply leaves them running:

   ```bash
   terraform -chdir=infra state rm \
     'aws_ecs_service.service["portal"]' 'aws_ecs_service.service["web-ui"]' \
     'aws_lb_listener_rule.production["portal"]' \
     'aws_lb_target_group.service["portal"]' 'aws_lb_target_group.alternate["portal"]' \
     'aws_cloudwatch_log_group.service["portal"]' 'aws_cloudwatch_log_group.service["web-ui"]' \
     'aws_ecr_repository.service["portal"]' 'aws_ecr_repository.service["web-ui"]'
   ```

6. Apply the full plan. It attaches core to its front-door target group behind
   the lowest-precedence `/*` rule. Wait until core is stable again:

   ```bash
   terraform -chdir=infra plan -out=qm.tfplan
   terraform -chdir=infra apply qm.tfplan
   aws --profile <profile> --region <region> ecs wait services-stable \
     --cluster <cluster> --services <core-ecs-service>
   ```

7. Delete portal's listener rule. The public URL falls through to core's `/*`
   rule at once. Then delete the retired services and their resources:

   ```bash
   aws --profile <profile> --region <region> elbv2 delete-rule --rule-arn <portal-rule-arn>
   aws --profile <profile> --region <region> ecs delete-service --force \
     --cluster <cluster> --service <portal-ecs-service>
   aws --profile <profile> --region <region> ecs delete-service --force \
     --cluster <cluster> --service <web-ui-ecs-service>
   aws --profile <profile> --region <region> ecs wait services-inactive \
     --cluster <cluster> --services <portal-ecs-service> <web-ui-ecs-service>
   aws --profile <profile> --region <region> elbv2 delete-target-group --target-group-arn <portal-target-group-arn>
   aws --profile <profile> --region <region> elbv2 delete-target-group --target-group-arn <portal-alternate-target-group-arn>
   aws --profile <profile> --region <region> logs delete-log-group --log-group-name /ecs/<portal-ecs-service>
   aws --profile <profile> --region <region> logs delete-log-group --log-group-name /ecs/<web-ui-ecs-service>
   aws --profile <profile> --region <region> ecr delete-repository --force --repository-name <portal-ecr-repository>
   aws --profile <profile> --region <region> ecr delete-repository --force --repository-name <web-ui-ecr-repository>
   ```

8. Confirm `terraform -chdir=infra plan` reports no changes, then run
   `npm exec qm -- up --candidate candidate.json --yes`. It rolls core once
   more, because it rewrites the secret references in step 4's task
   definition. `qm up` returns once only the new task serves, while the old
   deployment keeps draining for several minutes. Wait until
   `aws ecs describe-services` lists a single deployment for core, then run
   `npm exec qm -- check --live`. Deploy with `qm up` from then on.

On a shared ALB, the company's target groups and listener rule live outside
this Terraform, and `aws.services.portal.targetGroup` no longer applies. Give
core's front door its own primary and alternate target groups on port 8000 and
name the primary in `aws.services.core.targetGroup`. In place of steps
5 to 7, attach core to that pair and the company's listener rule, wait until
core is stable, then delete the portal and web-ui services and their target
groups.

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
