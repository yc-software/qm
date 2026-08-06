import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { awsObjectStoreBucket, declaredVariables, terraformVars, terraformVarsDrift } from "../src/terraform.ts";
import type { QmConfig } from "../src/config.ts";

const DEPLOY_IMAGE = "acme-qm-sandbox";

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://agent.acme.example",
  target: "aws",
  services: ["core"],
  plugins: [],
  skills: [],
  env: { core: { AWS_DEPLOY_IMAGE: DEPLOY_IMAGE } },
  imageOverrides: {},
  sandbox: { app: "acme-sandboxes" },
  aws: {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme-qm",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/qm/",
    imageLabel: "release",
    deployEnvironment: "production",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: { ecrRepository: "qm-core", ecsService: "acme-core", cpu: 2048, memory: 4096 } },
  },
};

const declared = declaredVariables(readFileSync(new URL("../templates/aws/variables.tf", import.meta.url), "utf8"));
const mainTf = readFileSync(new URL("../templates/aws/main.tf", import.meta.url), "utf8");

test("declaredVariables reads the scaffolded variables.tf", () => {
  for (const name of [
    "org_id",
    "account_id",
    "certificate_arn",
    "db_name",
    "db_username",
    "github_repository",
    "github_oidc_provider_arn",
    "object_store_bucket",
    "transfer_lifecycle_prefix",
    "deploy_microvm_image",
    "deploy_microvm_execution_role_arn",
    "services",
    "secret_names",
  ]) {
    assert.ok(declared.includes(name), `variables.tf declares ${name}`);
  }
});

test("the ECS execution role can read every managed contract secret", () => {
  const policy = mainTf.match(/resource "aws_iam_role_policy" "task_secrets" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(policy, /secretsmanager:GetSecretValue/);
  assert.match(policy, /\[for secret in aws_secretsmanager_secret\.contract : secret\.arn\]/);
  assert.doesNotMatch(policy, /secret:\$\{var\.secrets_prefix\}\*/);
});

test("new S3 buckets use AWS's default public-access block without a separate mutation", () => {
  assert.ok(!declared.includes("manage_object_store_public_access_block"));
  assert.doesNotMatch(mainTf, /aws_s3_bucket_public_access_block/);
});

test("the deploy role registers task definitions only for configured ECS families", () => {
  const policy = mainTf.match(/resource "aws_iam_role_policy" "github_deploy" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const management = policy.match(/Sid\s*= "ManageStackTaskDefinitions"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  for (const action of ["ecs:ListTagsForResource", "ecs:RegisterTaskDefinition", "ecs:TagResource"]) {
    assert.match(management, new RegExp(action));
  }
  assert.doesNotMatch(policy, /ecs:(?:DeleteTaskDefinitions|DeregisterTaskDefinition)/);
  assert.match(management, /task-definition\/\$\{service\.ecs_service\}:\*/);
  assert.doesNotMatch(management, /Resource\s*= "\*"/);
  assert.doesNotMatch(management, /aws:RequestTag|aws:TagKeys|Condition/);
  const rollout = policy.match(/Sid\s*= "RollClusterServices"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  assert.match(rollout, /ecs:ListTagsForResource/);
  assert.match(rollout, /service\/\$\{var\.cluster_name\}\/\*/);
  const global = policy.match(/Sid\s*= "GlobalReads"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  assert.match(global, /Resource\s*= "\*"/);
  assert.doesNotMatch(global, /ecs:ListTagsForResource/);
});

test("AWS deployments retain recovery history and can create scoped predeploy snapshots", () => {
  const variables = readFileSync(new URL("../templates/aws/variables.tf", import.meta.url), "utf8");
  assert.match(variables, /variable "db_backup_retention_days" \{[\s\S]*default = 35/);
  assert.match(variables, /db_backup_retention_days >= 1 && var\.db_backup_retention_days <= 35/);
  const policy = mainTf.match(/resource "aws_iam_role_policy" "github_deploy" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(policy, /rds:DescribeDBSnapshots/);
  const snapshots = policy.match(/Sid\s*= "CreatePredeployDatabaseSnapshots"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  assert.match(snapshots, /rds:CreateDBSnapshot/);
  assert.match(snapshots, /aws_db_instance\.this\.arn/);
  assert.match(snapshots, /snapshot:\$\{aws_db_instance\.this\.identifier\}-predeploy-\*/);
  assert.doesNotMatch(snapshots, /Resource\s*= "\*"/);
  const managed = policy.match(/Sid\s*= "ManagePredeployDatabaseSnapshots"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  assert.match(managed, /rds:DeleteDBSnapshot/);
  assert.match(managed, /rds:AddTagsToResource/);
  assert.match(managed, /snapshot:\$\{aws_db_instance\.this\.identifier\}-predeploy-\*/);
  assert.doesNotMatch(managed, /aws_db_instance\.this\.arn|Resource\s*= "\*"/);
});

test("MicroVM build and runtime roles can write only their stack-owned log group", () => {
  const logGroup = mainTf.match(/resource "aws_cloudwatch_log_group" "microvm" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const buildPolicy =
    mainTf.match(
      /resource "aws_iam_role_policy" "microvm_build" \{([\s\S]*?)\n\}\n\nresource "aws_iam_role" "microvm_execution"/,
    )?.[1] ?? "";
  const runtimePolicy =
    mainTf.match(
      /resource "aws_iam_role_policy" "microvm_execution" \{([\s\S]*?)\n\}\n\nresource "aws_iam_role" "github_deploy"/,
    )?.[1] ?? "";

  assert.match(logGroup, /name\s*= "\/aws\/lambda\/microvms\/\$\{var\.deploy_microvm_image\}"/);
  assert.match(logGroup, /retention_in_days\s*= 30/);
  for (const policy of [buildPolicy, runtimePolicy]) {
    assert.match(
      policy,
      /Action\s*= \["logs:CreateLogGroup"\][\s\S]*Resource\s*= aws_cloudwatch_log_group\.microvm\.arn/,
    );
    assert.match(
      policy,
      /Action\s*= \["logs:CreateLogStream", "logs:PutLogEvents"\][\s\S]*Resource\s*= "\$\{aws_cloudwatch_log_group\.microvm\.arn\}:\*"/,
    );
    assert.doesNotMatch(
      policy,
      /arn:aws:logs:\$\{var\.region\}:\$\{data\.aws_caller_identity\.current\.account_id\}:\*/,
    );
  }
});

test("terraform propagates workload architecture to bootstrap task definitions", () => {
  const rendered = terraformVars(
    {
      ...config,
      aws: {
        ...config.aws!,
        services: {
          core: { ...config.aws!.services.core!, architecture: "amd64" },
        },
      },
    },
    "",
    declared,
  );
  assert.match(rendered, /"core": \{[\s\S]*?"architecture": "amd64"/);
  assert.match(rendered, /"core": \{[\s\S]*?"internal_port": 8080/);
  assert.match(mainTf, /cpu_architecture\s*= each\.value\.architecture == "amd64" \? "X86_64" : "ARM64"/);
  assert.match(mainTf, /service\.internal_port/);
});

test("re-render preserves every declared operator variable, not just the github coordinates", () => {
  const first = terraformVars(config, "", declared);
  assert.match(first, /certificate_arn\s*= ""/, "fresh tfvars select the valid HTTP listener bootstrap");
  const edited =
    `${first}db_name             = "customdb"\ndb_username         = "customuser"\ndb_multi_az         = true\ndb_skip_final_snapshot = true\necr_force_delete = true\nobject_store_force_destroy = true\nsecret_recovery_window_days = 0\n`
      .replace('github_repository   = "replace-me/repository"', 'github_repository   = "acme/deploy"')
      .replace(/certificate_arn\s+= ""/, 'certificate_arn     = "arn:aws:acm:us-west-2:123456789012:certificate/abc"');
  const rerendered = terraformVars({ ...config, publicUrl: "https://new.acme.example" }, edited, declared);
  assert.match(rerendered, /public_url {2,}= "https:\/\/new\.acme\.example"/, "derived vars re-render from config");
  assert.match(rerendered, /github_repository {2,}= "acme\/deploy"/, "operator github coordinate preserved");
  assert.match(rerendered, /certificate_arn {2,}= "arn:aws:acm:us-west-2:123456789012:certificate\/abc"/);
  assert.match(rerendered, /db_name {2,}= "customdb"/);
  assert.match(rerendered, /db_username {2,}= "customuser"/);
  assert.match(rerendered, /db_multi_az\s*= true/);
  assert.match(rerendered, /db_skip_final_snapshot\s*= true/);
  assert.match(rerendered, /ecr_force_delete\s*= true/);
  assert.match(rerendered, /object_store_force_destroy\s*= true/);
  assert.match(rerendered, /secret_recovery_window_days\s*= 0/);
  assert.equal(
    terraformVars(config, rerendered, declared).includes('db_name             = "customdb"'),
    true,
    "render is stable across runs",
  );
});

test("re-render preserves indented operator assignments", () => {
  const existing = '  db_name = "customdb"\n\tdb_multi_az = true\n';
  const rendered = terraformVars(config, existing, declared);
  assert.match(rendered, /^ {2}db_name = "customdb"$/m);
  assert.match(rendered, /^\tdb_multi_az = true$/m);
});

test("terraform derives account-scoped infrastructure coordinates", () => {
  const rendered = terraformVars(config, "", declared);
  assert.match(rendered, /account_id\s*= "123456789012"/);
  assert.match(rendered, /github_environment\s*= "production"/);
  assert.match(
    rendered,
    /github_oidc_provider_arn\s*= "arn:aws:iam::123456789012:oidc-provider\/token\.actions\.githubusercontent\.com"/,
  );
  assert.match(rendered, new RegExp(`object_store_bucket\\s*= ${JSON.stringify(awsObjectStoreBucket(config))}`));
  assert.match(awsObjectStoreBucket(config), /^qm-acme-[0-9a-f]{12}$/);
  assert.match(
    mainTf,
    /var\.github_environment != ""[\s\S]*repo:\$\{var\.github_repository\}:environment:\$\{var\.github_environment\}/,
  );
  assert.match(
    mainTf,
    /"token\.actions\.githubusercontent\.com:sub" = compact\(\[[\s\S]*repo:\$\{var\.github_repository\}:ref:\$\{var\.github_ref\}[\s\S]*\]\)/,
  );
});

test("GitHub environments remain compatible with AWS scaffolds created before the variable existed", () => {
  const legacyDeclared = declared.filter((name) => name !== "github_environment");
  const legacyConfig: QmConfig = {
    ...config,
    aws: { ...config.aws!, deployEnvironment: undefined },
  };
  const rendered = terraformVars(legacyConfig, "", legacyDeclared);
  assert.doesNotMatch(rendered, /github_environment/);
  assert.deepEqual(terraformVarsDrift(legacyConfig, rendered, legacyDeclared), []);
  assert.throws(
    () => terraformVars(config, rendered, legacyDeclared),
    /AWS scaffold predates aws\.deployEnvironment[\s\S]*variables\.tf[\s\S]*main\.tf/,
  );
  assert.throws(
    () => terraformVarsDrift(config, rendered, legacyDeclared),
    /AWS scaffold predates aws\.deployEnvironment[\s\S]*variables\.tf[\s\S]*main\.tf/,
  );
});

test("terraform derives the transfer lifecycle prefix from the same core S3 prefix as runtime", () => {
  const unprefixed = terraformVars(config, "", declared);
  assert.match(unprefixed, /transfer_lifecycle_prefix\s*= "transfer\/"/);
  const prefixed = terraformVars(
    {
      ...config,
      env: { core: { AWS_DEPLOY_IMAGE: DEPLOY_IMAGE, S3_PREFIX: "core/" } },
    },
    unprefixed,
    declared,
  );
  assert.match(prefixed, /transfer_lifecycle_prefix\s*= "core\/transfer\/"/);
  assert.deepEqual(
    terraformVarsDrift(
      { ...config, env: { core: { AWS_DEPLOY_IMAGE: DEPLOY_IMAGE, S3_PREFIX: "core/" } } },
      unprefixed,
      declared,
    ),
    ["transfer_lifecycle_prefix"],
  );
});

test("terraform owns secret containers but never creates operator-secret placeholder values", () => {
  const rendered = terraformVars(config, "", declared);
  const all = rendered.match(/secret_names\s*=\s*(\[[\s\S]*?\])\s*$/)?.[1] ?? "";
  assert.match(all, /CORE_SIGNING_SECRET/);
  assert.doesNotMatch(mainTf, /aws_secretsmanager_secret_version" "placeholder/);
  assert.doesNotMatch(mainTf, /secret_string\s*=\s*"replace-me"/);
  assert.match(mainTf, /aws_secretsmanager_secret_version" "database/);
});

test("AWS module keeps portal as the sole front door and preserves CLI-owned ECS state", () => {
  assert.match(mainTf, /public_service_names\s*= local\.has_portal \? \["portal"\] : \["core"\]/);
  assert.match(mainTf, /direct_path_services\s*= local\.has_portal \? \{\} : \{ core = \["\/v1\/\*"\] \}/);
  const listener = mainTf.match(/resource "aws_lb_listener" "public" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(listener, /for_each\s*= local\.has_portal \? \["portal"\] : \[\][\s\S]*type\s*= "forward"/);
  assert.match(
    listener,
    /for_each\s*= local\.has_portal \? \[\] : \["not-found"\][\s\S]*type\s*= "fixed-response"[\s\S]*status_code\s*= "404"/,
  );
  assert.doesNotMatch(listener, /target_group_arn\s*= aws_lb_target_group\.service\[local\.default_service\]/);
  assert.doesNotMatch(mainTf, /web-ui = \["\/web-ui\/\*"\]/);
  assert.doesNotMatch(mainTf, /admin = \["\/admin\/\*"\]/);
  assert.match(mainTf, /ignore_changes\s*= \[task_definition, desired_count\]/);
});

test("AWS module terminates public TLS at CloudFront independently of the ALB origin listener", () => {
  const listener = mainTf.match(/resource "aws_lb_listener" "public" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const edge = mainTf.match(/resource "aws_cloudfront_distribution" "portal" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(listener, /port\s*=\s*var\.certificate_arn == "" \? 80 : 443/);
  assert.match(edge, /domain_name\s*=\s*aws_lb\.this\.dns_name/);
  assert.match(edge, /cloudfront_default_certificate\s*=\s*true/);
});

test("AWS module reuses account OIDC, guards account and passes configured task roles", () => {
  const versions = readFileSync(new URL("../templates/aws/versions.tf", import.meta.url), "utf8");
  assert.doesNotMatch(mainTf, /resource "aws_iam_openid_connect_provider"/);
  assert.match(mainTf, /data "aws_iam_openid_connect_provider" "github"/);
  assert.match(mainTf, /Principal = \{ Federated = data\.aws_iam_openid_connect_provider\.github\.arn \}/);
  assert.match(versions, /allowed_account_ids\s*= \[var\.account_id\]/);
  assert.match(mainTf, /concat\(local\.execution_role_arns, local\.task_role_arns\)/);
  assert.match(mainTf, /coalesce\(each\.value\.execution_role_arn, local\.default_execution_role_arn\)/);
  assert.match(mainTf, /each\.key == "core" \? local\.core_task_role_arn : local\.default_task_role_arn/);
  assert.match(mainTf, /role = aws_iam_role\.core_task\.id/);
  assert.match(mainTf, /dynamodb:ConditionCheckItem/);
  assert.match(mainTf, /dynamodb:DescribeTable/);
  assert.doesNotMatch(mainTf, /dynamodb:TransactWriteItems/);
  assert.match(mainTf, /"dynamodb:GetItem"[\s\S]*"dynamodb:UpdateItem"/);
  assert.match(mainTf, /ecr:BatchDeleteImage/);
  assert.match(
    mainTf,
    /Sid\s*= "InspectObjectStore"[\s\S]*"s3:ListBucket", "s3:ListBucketVersions"[\s\S]*s3:prefix[\s\S]*deployment\/\*/,
  );
  assert.match(
    mainTf,
    /Sid\s*= "ManageDeploymentLayers"[\s\S]*"s3:GetObject", "s3:PutObject"[\s\S]*deployment\/layers\/\*/,
  );
  assert.match(mainTf, /Sid\s*= "InspectGithubOidcProvider"[\s\S]*iam:GetOpenIDConnectProvider/);
  assert.match(mainTf, /"ecs:GetTaskProtection", "ecs:UpdateTaskProtection"/);
  assert.match(mainTf, /task\/\$\{var\.cluster_name\}\/\*/);
  assert.match(mainTf, /"lambda:RunMicrovm"[\s\S]*"lambda:CreateMicrovmAuthToken"/);
  assert.match(mainTf, /"lambda:ListMicrovmImages"/);
  assert.match(mainTf, /resource "aws_iam_role" "microvm_build"[\s\S]*lambda\.amazonaws\.com[\s\S]*sts:TagSession/);
  assert.match(mainTf, /deployment\/microvm-images\/\*/);
  assert.match(
    mainTf,
    /lambda:GetMicrovmImage[\s\S]*lambda:GetMicrovmImageVersion[\s\S]*lambda:ListMicrovmImageVersions/,
  );
  const manageImage = mainTf.match(/Sid\s*= "ManageStackMicrovmImage"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  assert.match(manageImage, /lambda:UpdateMicrovmImage/);
  assert.match(manageImage, /lambda:DeleteMicrovmImage/);
  assert.match(manageImage, /microvm-image:\$\{var\.deploy_microvm_image\}/);
  assert.doesNotMatch(manageImage, /Resource\s*= "\*"/);
  const createImage = mainTf.match(/Sid\s*= "CreateStackMicrovmImage"([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  assert.match(createImage, /lambda:CreateMicrovmImage/);
  assert.match(createImage, /Resource\s*= "\*"/);
  assert.doesNotMatch(mainTf, /aws:RequestTag|aws:ResourceTag|aws:TagKeys|AdoptUntaggedStackMicrovmImage/);
  assert.match(
    mainTf,
    /Sid\s*= "ManageMicrovmBuildArtifacts"[\s\S]*"s3:DeleteObject", "s3:DeleteObjectVersion"[\s\S]*deployment\/microvm-images\/\*/,
  );
  assert.match(mainTf, /Action\s*=\s*\["iam:PassRole"\]\s*Resource\s*=\s*var\.deploy_microvm_execution_role_arn\s*\}/);
  assert.match(mainTf, /lambda:PassNetworkConnector/);
  const rendered = terraformVars(
    {
      ...config,
      aws: {
        ...config.aws!,
        services: {
          core: {
            ...config.aws!.services.core!,
            taskRoleArn: "arn:aws:iam::123456789012:role/custom-task",
            executionRoleArn: "arn:aws:iam::123456789012:role/custom-execution",
          },
        },
      },
    },
    "",
    declared,
  );
  assert.match(rendered, /"task_role_arn": "arn:aws:iam::123456789012:role\/custom-task"/);
  assert.match(rendered, /"execution_role_arn": "arn:aws:iam::123456789012:role\/custom-execution"/);
});

test("AWS module provisions durable encrypted object storage and configurable safe teardown", () => {
  assert.match(mainTf, /resource "aws_s3_bucket" "objects"/);
  assert.match(mainTf, /sse_algorithm = "AES256"/);
  assert.match(mainTf, /versioning_configuration \{ status = "Enabled" \}/);
  assert.match(mainTf, /resource "aws_s3_bucket_lifecycle_configuration" "objects"/);
  assert.match(mainTf, /depends_on = \[aws_s3_bucket_versioning\.objects\]/);
  assert.match(
    mainTf,
    /id\s*= "qm-transfer-expiry"[\s\S]*?prefix\s*= var\.transfer_lifecycle_prefix[\s\S]*?days\s*= 1/,
  );
  assert.match(mainTf, /noncurrent_version_expiration\s*\{\s*noncurrent_days\s*= 1\s*\}/);
  assert.match(mainTf, /expiration\s*\{\s*expired_object_delete_marker\s*= true\s*\}/);
  assert.match(mainTf, /"s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"/);
  assert.match(mainTf, /"s3:ListBucketMultipartUploads"/);
  assert.match(
    mainTf,
    /id\s*= "qm-transfer-expiry"[\s\S]*?abort_incomplete_multipart_upload\s*\{\s*days_after_initiation\s*= 1\s*\}/,
  );
  assert.match(mainTf, /backup_retention_period\s*= var\.db_backup_retention_days/);
  assert.match(mainTf, /multi_az\s*= var\.db_multi_az/);
  assert.match(mainTf, /skip_final_snapshot\s*= var\.db_skip_final_snapshot/);
  assert.match(mainTf, /recovery_window_in_days = var\.secret_recovery_window_days/);
  assert.match(mainTf, /force_delete = var\.ecr_force_delete/);
});

test("AWS module discovers AZs and uses collision-resistant target group names", () => {
  assert.match(mainTf, /data "aws_availability_zones" "available"/);
  assert.match(mainTf, /check "two_availability_zones"/);
  assert.doesNotMatch(mainTf, /"\$\{var\.region\}a"/);
  assert.match(
    mainTf,
    /alb_name\s*= "\$\{substr\(var\.cluster_name, 0, 23\)\}-\$\{substr\(sha1\(var\.cluster_name\), 0, 8\)\}"/,
  );
  assert.match(mainTf, /substr\(sha1\("\$\{var\.cluster_name\}:\$\{each\.key\}"\), 0, 6\)/);
});

test("AWS ECS services wait until target groups are attached to the ALB", () => {
  const service = mainTf.match(/resource "aws_ecs_service" "service" \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(service, /depends_on\s*= \[aws_lb_listener\.public, aws_lb_listener_rule\.paths\]/);
});

test("drift check flags wrong derived values but never operator formatting", () => {
  const rendered = terraformVars(config, "", declared);
  assert.deepEqual(terraformVarsDrift(config, rendered, declared), []);
  const reordered = `certificate_arn = "arn:x"\n# an operator comment\n${rendered}`;
  assert.deepEqual(terraformVarsDrift(config, reordered, declared), [], "operator additions/formatting are not drift");
  const wrongCluster = rendered.replace('"acme-qm"', '"other-cluster"');
  assert.deepEqual(terraformVarsDrift(config, wrongCluster, declared), ["cluster_name"]);
  const wrongServices = rendered.replace('"cpu": 2048', '"cpu": 1024');
  assert.deepEqual(terraformVarsDrift(config, wrongServices, declared), ["services"]);
  assert.ok(terraformVarsDrift(config, "", declared).length >= 8, "an empty file drifts on every derived var");
});
