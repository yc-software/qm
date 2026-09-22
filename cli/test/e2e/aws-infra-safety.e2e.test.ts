import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME } from "../../src/config.ts";
import { rmDir, runCli, tmp } from "./harness.ts";

const terraformCandidates = [process.env.QM_TERRAFORM_BIN, "terraform"].filter((value): value is string =>
  Boolean(value),
);
const terraformBin = terraformCandidates.find(
  (candidate) => spawnSync(candidate, ["version"], { stdio: "ignore" }).status === 0,
);

function terraform(args: string[], cwd: string, blockAws = false) {
  const result = spawnSync(terraformBin!, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_EC2_METADATA_DISABLED: "true",
      TF_IN_AUTOMATION: "1",
      ...(blockAws
        ? {
            ALL_PROXY: "http://127.0.0.1:1",
            AWS_ENDPOINT_URL: "http://127.0.0.1:1",
            AWS_MAX_ATTEMPTS: "1",
            HTTP_PROXY: "http://127.0.0.1:1",
            HTTPS_PROXY: "http://127.0.0.1:1",
            NO_PROXY: "",
          }
        : {}),
    },
    timeout: 180_000,
  });
  return { code: result.status ?? 124, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function providerConfig(bucket: string, bucketResource: string): string {
  return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.6, < 7.0"
    }
  }
}

provider "aws" {
  region                      = "us-west-2"
  access_key                  = "synthetic"
  secret_key                  = "synthetic"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
}

variable "object_store_bucket" { default = ${JSON.stringify(bucket)} }
variable "object_store_force_destroy" { default = false }
locals { tags = { Deployment = "acme", ManagedBy = "terraform" } }

${bucketResource}
`;
}

function syntheticBucketState(): string {
  return `${JSON.stringify(
    {
      version: 4,
      terraform_version: "1.15.8",
      serial: 1,
      lineage: "00000000-0000-4000-8000-000000000354",
      outputs: {},
      resources: [
        {
          mode: "managed",
          type: "aws_s3_bucket",
          name: "objects",
          provider: 'provider["registry.terraform.io/hashicorp/aws"]',
          instances: [
            {
              schema_version: 0,
              attributes: {
                acceleration_status: "",
                arn: "arn:aws:s3:::qm-acme-existing",
                bucket: "qm-acme-existing",
                bucket_domain_name: "qm-acme-existing.s3.amazonaws.com",
                bucket_prefix: "",
                bucket_region: "us-west-2",
                bucket_regional_domain_name: "qm-acme-existing.s3.us-west-2.amazonaws.com",
                force_destroy: false,
                hosted_zone_id: "Z3BJ6K6RIION7M",
                id: "qm-acme-existing",
                object_lock_enabled: false,
                policy: "",
                region: "us-west-2",
                request_payer: "BucketOwner",
                tags: { Deployment: "acme", ManagedBy: "terraform" },
                tags_all: { Deployment: "acme", ManagedBy: "terraform" },
                website: [],
                website_domain: "",
                website_endpoint: "",
              },
              sensitive_attributes: [],
              identity_schema_version: 0,
            },
          ],
        },
      ],
      check_results: null,
    },
    null,
    2,
  )}\n`;
}

test("AWS init refuses to render the scaffold account and renders corrected config", () => {
  const root = tmp("aws-infra-render");
  const deployment = join(root, "deployment");
  try {
    const initialized = runCli(["init", deployment, "--org", "acme", "--target", "aws"]);
    assert.equal(initialized.code, 0, initialized.out);
    const placeholderRender = runCli(["infra", "render"], { cwd: deployment });
    assert.equal(placeholderRender.code, 1, placeholderRender.out);
    assert.match(placeholderRender.out, /replace the scaffolded aws\.accountId "000000000000"/);
    const configPath = join(deployment, CONFIG_FILENAME);
    writeFileSync(configPath, readFileSync(configPath, "utf8").replaceAll("000000000000", "123456789012"));
    const rendered = runCli(["infra", "render"], { cwd: deployment });
    assert.equal(rendered.code, 0, rendered.out);
  } finally {
    rmDir(root);
  }
});

test(
  "rendered AWS infrastructure passes Terraform validation and blocks bucket replacement",
  { skip: terraformBin ? false : "Terraform is unavailable" },
  () => {
    const root = tmp("aws-infra-safety");
    const deployment = join(root, "deployment");
    try {
      const initialized = runCli(["init", deployment, "--org", "acme", "--target", "aws"]);
      assert.equal(initialized.code, 0, initialized.out);

      const placeholderRender = runCli(["infra", "render"], { cwd: deployment });
      assert.equal(placeholderRender.code, 1, placeholderRender.out);
      assert.match(placeholderRender.out, /replace the scaffolded aws\.accountId "000000000000"/);

      const infra = join(deployment, "infra");
      const tfvarsPath = join(infra, "terraform.tfvars");
      writeFileSync(tfvarsPath, readFileSync(tfvarsPath, "utf8").replace("replace-me/repository", "acme/deploy"));
      writeFileSync(
        join(infra, "safety.tftest.hcl"),
        `mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
}

mock_provider "random" {}

run "plan" {
  command = plan
}
`,
      );
      const initializedTerraform = terraform(["init", "-backend=false", "-input=false", "-no-color"], infra);
      assert.equal(initializedTerraform.code, 0, initializedTerraform.out);
      const placeholderPlan = terraform(["test", "-no-color"], infra);
      assert.equal(placeholderPlan.code, 1, placeholderPlan.out);
      assert.match(placeholderPlan.out, /var\.account_id is "000000000000"/);
      assert.match(
        placeholderPlan.out,
        /account_id must replace the scaffold value 000000000000 before planning or\s+applying infrastructure/,
      );

      const configPath = join(deployment, CONFIG_FILENAME);
      writeFileSync(configPath, readFileSync(configPath, "utf8").replaceAll("000000000000", "123456789012"));
      const rendered = runCli(["infra", "render"], { cwd: deployment });
      assert.equal(rendered.code, 0, rendered.out);
      const scaffoldPlan = terraform(["test", "-no-color"], infra);
      assert.equal(scaffoldPlan.code, 0, scaffoldPlan.out);
      assert.match(scaffoldPlan.out, /Success! 1 passed, 0 failed/);

      const schema = join(root, "provider-schema");
      mkdirSync(schema);
      cpSync(join(infra, ".terraform"), join(schema, ".terraform"), { recursive: true });
      cpSync(join(infra, ".terraform.lock.hcl"), join(schema, ".terraform.lock.hcl"));
      writeFileSync(join(schema, "terraform.tfstate"), syntheticBucketState());

      const renderedMain = readFileSync(join(infra, "main.tf"), "utf8");
      const bucketResource = renderedMain.match(
        /(resource "aws_s3_bucket" "objects" \{[\s\S]*?\n\})\n\nresource "aws_s3_bucket_policy"/,
      )?.[1];
      assert.ok(bucketResource);
      assert.match(bucketResource, /lifecycle \{ prevent_destroy = true \}/);
      const baselineResource = bucketResource.replace(/\n\s*lifecycle \{ prevent_destroy = true \}/, "");

      writeFileSync(join(schema, "main.tf"), providerConfig("qm-acme-replacement", baselineResource));
      const baseline = terraform(
        ["plan", "-refresh=false", "-input=false", "-no-color", "-detailed-exitcode"],
        schema,
        true,
      );
      assert.equal(baseline.code, 2, baseline.out);
      assert.match(baseline.out, /aws_s3_bucket\.objects must be replaced/);
      assert.match(baseline.out, /Plan: 1 to add, 0 to change, 1 to destroy/);

      writeFileSync(join(schema, "main.tf"), providerConfig("qm-acme-replacement", bucketResource));
      const fixed = terraform(
        ["plan", "-refresh=false", "-input=false", "-no-color", "-detailed-exitcode"],
        schema,
        true,
      );
      assert.equal(fixed.code, 1, fixed.out);
      assert.match(fixed.out, /Resource aws_s3_bucket\.objects has lifecycle\.prevent_destroy set/);

      writeFileSync(join(schema, "main.tf"), providerConfig("qm-acme-existing", bucketResource));
      const pinned = terraform(
        ["plan", "-refresh=false", "-input=false", "-no-color", "-detailed-exitcode"],
        schema,
        true,
      );
      assert.equal(pinned.code, 0, pinned.out);
      assert.match(pinned.out, /No changes/);
    } finally {
      rmDir(root);
    }
  },
);
