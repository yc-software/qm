import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rmDir, runCli, tmp } from "./harness.ts";

function terraformExecutable(): string | undefined {
  const configured = process.env.QM_TEST_TERRAFORM;
  const executable = configured === undefined ? "terraform" : configured;
  const result = spawnSync(executable, ["version"], { stdio: "ignore" });
  return result.status === 0 ? executable : undefined;
}

function configureClass(dir: string, value: string): void {
  const path = join(dir, "qm.config.jsonc");
  const source = readFileSync(path, "utf8");
  writeFileSync(
    path,
    source.replace('    "imageLabel": "latest",', `    "imageLabel": "latest",\n    "dbInstanceClass": "${value}",`),
  );
}

function configureAwsCoordinates(dir: string): void {
  const path = join(dir, "qm.config.jsonc");
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("000000000000", "123456789012"));
}

function configureTerraform(dir: string, retention?: number): void {
  const path = join(dir, "infra", "terraform.tfvars");
  const source = readFileSync(path, "utf8").replace(
    'github_repository   = "replace-me/repository"',
    'github_repository   = "example/deployment"',
  );
  writeFileSync(path, retention === undefined ? source : `${source}db_backup_retention_days = ${retention}\n`);
}

function writeTerraformTest(dir: string, instanceClass: string, retention: number): void {
  writeFileSync(
    join(dir, "infra", "database.tftest.hcl"),
    `mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
}
mock_provider "random" {}
run "plan" {
  command = plan
  assert {
    condition = aws_db_instance.this.instance_class == "${instanceClass}" && aws_db_instance.this.backup_retention_period == ${retention}
    error_message = "planned RDS configuration did not match"
  }
}
`,
  );
}

function terraform(dir: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, [`-chdir=${join(dir, "infra")}`, ...args], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  return output;
}

const terraformBin = terraformExecutable();
const terraformRequested = process.env.QM_TEST_TERRAFORM !== undefined;

test("AWS init and render validate RDS class config and preserve operator Terraform values", () => {
  const defaultDir = tmp("aws-rds-render-default");
  const overrideDir = tmp("aws-rds-render-override");
  const invalidDir = tmp("aws-rds-render-invalid");
  try {
    for (const [dir, org] of [
      [defaultDir, "rds-render-default"],
      [overrideDir, "rds-render-override"],
      [invalidDir, "rds-render-invalid"],
    ] as const) {
      const initialized = runCli(["init", dir, "--org", org, "--target", "aws", "--model-provider", "anthropic"]);
      assert.equal(initialized.code, 0, initialized.out);
      configureAwsCoordinates(dir);
    }

    configureTerraform(defaultDir);
    const defaultRendered = runCli(["infra", "render", "--config", join(defaultDir, "qm.config.jsonc")]);
    assert.equal(defaultRendered.code, 0, defaultRendered.out);
    assert.doesNotMatch(readFileSync(join(defaultDir, "infra", "terraform.tfvars"), "utf8"), /db_instance_class/);

    configureClass(overrideDir, "db.t4g.micro");
    configureTerraform(overrideDir, 7);
    const overridden = runCli(["infra", "render", "--config", join(overrideDir, "qm.config.jsonc")]);
    assert.equal(overridden.code, 0, overridden.out);
    const tfvars = readFileSync(join(overrideDir, "infra", "terraform.tfvars"), "utf8");
    assert.match(tfvars, /db_instance_class\s*= "db\.t4g\.micro"/);
    assert.match(tfvars, /db_backup_retention_days = 7/);

    configureClass(invalidDir, "t4g.micro");
    const rejected = runCli(["infra", "render", "--config", join(invalidDir, "qm.config.jsonc")]);
    assert.equal(rejected.code, 1, rejected.out);
    assert.match(rejected.out, /aws\.dbInstanceClass/);
  } finally {
    rmDir(defaultDir);
    rmDir(overrideDir);
    rmDir(invalidDir);
  }
});

test(
  "AWS init renders validated RDS class config into a local Terraform resource plan",
  { skip: !terraformRequested && !terraformBin ? "Terraform is unavailable" : false },
  () => {
    assert.ok(terraformBin, `QM_TEST_TERRAFORM is not executable: ${process.env.QM_TEST_TERRAFORM}`);
    const defaultDir = tmp("aws-rds-default");
    const overrideDir = tmp("aws-rds-override");
    try {
      for (const [dir, org] of [
        [defaultDir, "rds-default"],
        [overrideDir, "rds-override"],
      ] as const) {
        const initialized = runCli(["init", dir, "--org", org, "--target", "aws", "--model-provider", "anthropic"]);
        assert.equal(initialized.code, 0, initialized.out);
        configureAwsCoordinates(dir);
      }

      configureTerraform(defaultDir);
      const defaultRendered = runCli(["infra", "render", "--config", join(defaultDir, "qm.config.jsonc")]);
      assert.equal(defaultRendered.code, 0, defaultRendered.out);
      writeTerraformTest(defaultDir, "db.t4g.small", 35);

      configureClass(overrideDir, "db.t4g.micro");
      configureTerraform(overrideDir, 7);
      const rendered = runCli(["infra", "render", "--config", join(overrideDir, "qm.config.jsonc")]);
      assert.equal(rendered.code, 0, rendered.out);
      const tfvars = readFileSync(join(overrideDir, "infra", "terraform.tfvars"), "utf8");
      assert.match(tfvars, /db_instance_class\s*= "db\.t4g\.micro"/);
      assert.match(tfvars, /db_backup_retention_days = 7/);
      writeTerraformTest(overrideDir, "db.t4g.micro", 7);

      for (const dir of [defaultDir, overrideDir]) {
        terraform(dir, terraformBin, ["init", "-backend=false"]);
        const plan = terraform(dir, terraformBin, ["test", "-verbose"]);
        assert.match(plan, /Success!.*1 passed, 0 failed/s);
      }

      const overrideTfvars = join(overrideDir, "infra", "terraform.tfvars");
      writeFileSync(
        overrideTfvars,
        readFileSync(overrideTfvars, "utf8").replace(
          /db_instance_class\s*=\s*"db\.t4g\.micro"/,
          'db_instance_class = "t4g.micro"',
        ),
      );
      const invalidPlan = spawnSync(terraformBin, [`-chdir=${join(overrideDir, "infra")}`, "test", "-verbose"], {
        encoding: "utf8",
        timeout: 180_000,
      });
      const invalidOutput = `${invalidPlan.stdout ?? ""}${invalidPlan.stderr ?? ""}`;
      assert.notEqual(invalidPlan.status, 0, invalidOutput);
      assert.match(invalidOutput, /db_instance_class must be a valid RDS DB instance class/);
    } finally {
      rmDir(defaultDir);
      rmDir(overrideDir);
    }
  },
);

test(
  "AWS init plans the egress proxy behind its own TLS network load balancer",
  { skip: !terraformRequested && !terraformBin ? "Terraform is unavailable" : false },
  () => {
    assert.ok(terraformBin, `QM_TEST_TERRAFORM is not executable: ${process.env.QM_TEST_TERRAFORM}`);
    const dir = tmp("aws-egress-proxy");
    try {
      const initialized = runCli(["init", dir, "--org", "egress", "--target", "aws", "--model-provider", "anthropic"]);
      assert.equal(initialized.code, 0, initialized.out);
      configureAwsCoordinates(dir);
      const path = join(dir, "qm.config.jsonc");
      writeFileSync(
        path,
        readFileSync(path, "utf8")
          .replace('"services": [', '"services": ["egress-proxy", ')
          .replace(
            '"services": {',
            '"services": { "egress-proxy": { "ecrRepository": "egress-proxy", "ecsService": "egress-proxy", "cpu": 512, "memory": 1024 },',
          ),
      );
      configureTerraform(dir);
      const rendered = runCli(["infra", "render", "--config", path]);
      assert.equal(rendered.code, 0, rendered.out);
      writeFileSync(
        join(dir, "infra", "egress.tftest.hcl"),
        `mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
}
mock_provider "random" {}
run "tls" {
  command = plan
  variables { certificate_arn = "arn:aws:acm:us-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000" }
  assert {
    condition = aws_lb.egress_proxy["egress-proxy"].load_balancer_type == "network" && aws_lb_listener.egress_proxy["egress-proxy"].port == 443 && aws_lb_listener.egress_proxy["egress-proxy"].protocol == "TLS"
    error_message = "the proxy is not behind a TLS network load balancer"
  }
  assert {
    condition = aws_lb_target_group.egress_proxy["egress-proxy"].protocol == "TCP" && aws_lb_target_group.egress_proxy["egress-proxy"].port == 48080 && length(aws_ecs_service.service["egress-proxy"].load_balancer) == 1 && !contains(keys(aws_lb_target_group.service), "egress-proxy")
    error_message = "the proxy is not attached to its TCP target group alone"
  }
  assert {
    condition = aws_ecs_service.service["egress-proxy"].deployment_configuration[0].strategy == "ROLLING" && aws_ecs_service.service["core"].deployment_configuration[0].strategy == "BLUE_GREEN"
    error_message = "unexpected rollout strategies"
  }
}
run "plaintext" {
  command = plan
  expect_failures = [aws_lb_listener.egress_proxy]
}
`,
      );
      terraform(dir, terraformBin, ["init", "-backend=false"]);
      assert.match(terraform(dir, terraformBin, ["test", "-verbose"]), /Success!.*2 passed, 0 failed/s);
    } finally {
      rmDir(dir);
    }
  },
);
