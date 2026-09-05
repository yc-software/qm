import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import { CONFIG_FILENAME, loadConfigInDir } from "../src/config.ts";
import { cliVersion } from "../src/manifest.ts";
import { parseToolDescriptor, validateSandboxLayer } from "../src/sandbox-layer.ts";
import { SERVICE_NAMES, VIRTUAL_SERVICE_NAMES } from "../src/services.ts";
import { renderEnvExample } from "../src/secrets.ts";
import { runChecks } from "../src/commands/check.ts";
import { renderTerraformVars } from "../src/terraform.ts";
import { requiredSlackScopes, slackManifestBotScopes } from "../src/backends/doctor.ts";

function quiet<T>(fn: () => T): T {
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = (): void => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function captureInit(opts: Parameters<typeof runInit>[0]): string {
  const lines: string[] = [];
  const log = console.log,
    warn = console.warn;
  console.log = (...args: unknown[]): void => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]): void => void lines.push(args.join(" "));
  try {
    runInit(opts);
    return lines.join("\n");
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

test("init scaffolds a loadable config, generated local secrets, and a valid sandbox/ layer", () => {
  const base = mkdtempSync(join(tmpdir(), "qm-init-"));
  try {
    const dir = join(base, "nested", "acme");
    quiet(() => runInit({ dir, org: "acme", target: "docker" }));

    const configRaw = readFileSync(join(dir, CONFIG_FILENAME), "utf8");
    assert.match(configRaw, /^\s*\/\//m, "the scaffolded config carries field comments");
    for (const service of [...SERVICE_NAMES, ...VIRTUAL_SERVICE_NAMES]) {
      assert.ok(configRaw.includes(`"${service}"`), `the config's services comment should describe ${service}`);
    }
    const { config } = loadConfigInDir(dir);
    assert.equal(config.orgId, "acme");
    assert.equal(config.target, "docker");
    assert.equal(config.publicUrl, "http://localhost:8082");
    assert.equal(config.env.core?.HARNESS, "pi");
    assert.equal(config.modelProvider, "anthropic", "init names a base model provider by default");
    assert.deepEqual(config.sandbox, { app: "acme-sandboxes" });

    const env = readFileSync(join(dir, ".env.example"), "utf8");
    assert.equal(env, renderEnvExample(config), ".env.example is exactly renderEnvExample output");
    // The scaffold names anthropic as the base model provider, so its key is required
    // rather than deferred to Admin; the providers not selected stay optional.
    for (const line of ["CORE_SIGNING_SECRET=", "SKILL_SIGNING_SECRET=", "ANTHROPIC_API_KEY="]) {
      assert.ok(env.split("\n").includes(line), `.env.example should require ${line}`);
    }
    for (const line of ["# OPENROUTER_API_KEY=  # optional"]) {
      assert.ok(env.split("\n").includes(line), `.env.example should offer ${line}`);
    }
    // OPENAI_API_KEY answers to two independent rules; the catalog lists both so neither
    // route to requiring it is hidden behind the other.
    for (const line of [
      '# Needed when env.core.HARNESS is "codex" or modelProvider is "openai".',
      "# OPENAI_API_KEY=",
    ]) {
      assert.ok(env.split("\n").includes(line), `.env.example should defer ${line}`);
    }
    assert.ok(env.includes("# Generate with: openssl rand -hex 32"), "mintable secrets carry their generation command");
    const localEnv = readFileSync(join(dir, ".env"), "utf8");
    const coreSecret = localEnv.match(/^CORE_SIGNING_SECRET=([a-f0-9]{64})$/m)?.[1];
    const skillSecret = localEnv.match(/^SKILL_SIGNING_SECRET=([a-f0-9]{64})$/m)?.[1];
    assert.ok(coreSecret, "init generates a strong core signing key");
    assert.ok(skillSecret, "init generates a strong skill signing key");
    assert.notEqual(coreSecret, skillSecret, "generated keys are independent");
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600, ".env is owner-readable only");
    for (const stale of ["HARNESS=", "ORG_ID=", "PORT=", "SESSION_STORE"]) {
      assert.ok(!env.includes(stale), `.env.example should not offer ${stale} as a value to fill in`);
    }

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8").split("\n");
    assert.ok(gitignore.includes(".env"), ".gitignore should cover .env");

    const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf8");
    for (const piece of [CONFIG_FILENAME, ".env.example", "sandbox/", "npm exec qm -- check", "npm exec qm -- up"]) {
      assert.ok(agentsMd.includes(piece), `AGENTS.md should mention ${piece}`);
    }
    assert.doesNotMatch(env, /ORG_ID=|PORT=|HARNESS=/);
    const manifest = readFileSync(join(dir, "slack-app-manifest.yml"), "utf8");
    assert.match(manifest, /^ {2}name: qm$/m);
    assert.match(manifest, /^ {4}display_name: qm$/m);
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);

    const skill = readFileSync(join(dir, "sandbox", "skills", "greet", "SKILL.md"), "utf8");
    assert.match(skill, /name: greet/);
    assert.match(skill, /description: Greet a teammate by name/);
    assert.match(skill, /example-tool/);

    const tj = parseToolDescriptor(
      readFileSync(join(dir, "sandbox", "tools", "example-tool", "tool.json"), "utf8"),
      "tool.json",
    );
    assert.equal(tj.id, "example-tool");
    assert.equal(tj.advertise, "example-tool");
    assert.equal(tj.install?.binary, "example-tool");

    const exe = join(dir, "sandbox", "tools", "example-tool", "example-tool");
    assert.ok(existsSync(exe));
    assert.ok(statSync(exe).mode & 0o111, "executable bit set on the tool binary");
    assert.match(readFileSync(exe, "utf8"), /Hello/);

    const layer = validateSandboxLayer(join(dir, "sandbox"));
    assert.deepEqual(layer.errors, [], "scaffolded sandbox layer must validate clean");
    assert.equal(layer.tools.length, 1);
    assert.equal(layer.skills.length, 1);
    assert.ok(layer.tools[0]!.executablePath, "the example tool ships an executable");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("init --target fly scaffolds the full hosted topology and both Slack apps", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-fly-"));
  try {
    quiet(() => runInit({ dir, org: "acme", target: "fly" }));
    const { config } = loadConfigInDir(dir);
    assert.equal(config.target, "fly");
    assert.deepEqual(config.services, ["core", "slack", "web-ui", "admin", "portal", "auth"]);
    assert.equal(config.publicUrl, "https://acme-portal.fly.dev");
    assert.equal(config.flyOrg, "personal");
    assert.ok(config.region, "region is scaffolded");
    assert.equal(config.appPrefix, "acme");
    assert.deepEqual(
      {
        SNAPSHOT_STORE: config.env.core?.SNAPSHOT_STORE,
        TRANSFER_STORE: config.env.core?.TRANSFER_STORE,
        S3_BUCKET: config.env.core?.S3_BUCKET,
        S3_REGION: config.env.core?.S3_REGION,
      },
      { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" },
    );
    assert.deepEqual(config.secretEnv?.core, { ADMIN_GRANTS: "ADMIN_GRANTS" });
    assert.equal(config.env.slack?.SLACK_IDENTITY_EMAIL, "1");
    assert.equal(config.env.auth?.AUTH_EMAIL_TRANSPORT, "resend");
    assert.equal(config.env.portal?.OIDC_PRINCIPAL_CLAIM, undefined, "the broker derives every OIDC_* value");
    const env = readFileSync(join(dir, ".env.example"), "utf8");
    for (const line of ["ADMIN_GRANTS=", "AUTH_ALLOWED_EMAILS=", "PORTAL_SESSION_SECRET=", "ANTHROPIC_API_KEY="]) {
      assert.ok(env.split("\n").includes(line), `.env.example should require ${line} for the fly scaffold`);
    }
    for (const line of [
      "# OPENROUTER_API_KEY=  # optional",
      "# SLACK_APP_TOKEN=  # optional",
      "# SLACK_BOT_TOKEN=  # optional",
      "# AUTH_EMAIL_FROM=  # optional",
      "# RESEND_API_KEY=  # optional",
    ]) {
      assert.ok(env.split("\n").includes(line), `.env.example should offer ${line}`);
    }
    assert.ok(existsSync(join(dir, "slack-app-manifest.yml")), "Slack manifest is scaffolded on fly too");
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);
    for (const line of ["# OIDC_CLIENT_ID=", "# OIDC_CLIENT_SECRET=", "# PORTAL_EXPECTED_TEAM_ID="]) {
      assert.ok(env.split("\n").includes(line), `external-IdP secret ${line} stays documented but unrequired`);
    }
    assert.ok(!env.includes("SMTP_"), "the unselected smtp transport's keys stay out of .env.example");
    assert.ok(!readFileSync(join(dir, ".env"), "utf8").includes("SMTP_"), "and out of .env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --email-transport smtp scaffolds smtp keys only and a matching config", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-smtp-"));
  try {
    quiet(() => runInit({ dir, org: "acme", target: "fly", emailTransport: "smtp" }));
    const { config } = loadConfigInDir(dir);
    assert.equal(config.env.auth?.AUTH_EMAIL_TRANSPORT, "smtp");
    const env = readFileSync(join(dir, ".env.example"), "utf8");
    assert.equal(env, renderEnvExample(config));
    for (const line of ["# SMTP_HOST=  # optional", "# SMTP_USERNAME=  # optional", "# SMTP_PASSWORD=  # optional"]) {
      assert.ok(env.split("\n").includes(line), `.env.example should offer ${line}`);
    }
    assert.ok(
      env.split("\n").includes("# RESEND_API_KEY=  # optional"),
      "the unselected resend transport's key stays optional: core alone uses it for external-user invitations",
    );
    assert.ok(!env.split("\n").includes("RESEND_API_KEY="), "and is never required");
    assert.ok(!readFileSync(join(dir, ".env"), "utf8").split("\n").includes("RESEND_API_KEY="), "in .env either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init keeps stable qm Slack branding for long org ids", () => {
  for (const org of ["a".repeat(34), `${"a".repeat(28)}-bcd`]) {
    const dir = mkdtempSync(join(tmpdir(), "qm-init-"));
    try {
      quiet(() => runInit({ dir, org }));
      const manifest = readFileSync(join(dir, "slack-app-manifest.yml"), "utf8");
      assert.match(manifest, /^ {2}name: qm$/m);
      assert.match(manifest, /^ {4}display_name: qm$/m);
      assert.ok(manifest.includes(`qm workspace agent for ${org}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("init derives sandbox.app from --org", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-"));
  try {
    quiet(() => runInit({ dir, org: "globex" }));
    assert.deepEqual(loadConfigInDir(dir).config.sandbox, { app: "globex-sandboxes" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --target aws scaffolds the full hosted topology, Terraform, and the optional Slack bot manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-"));
  try {
    quiet(() => runInit({ dir, org: "acme", target: "aws" }));
    const { config } = loadConfigInDir(dir);
    assert.equal(config.target, "aws");
    assert.equal(config.publicUrl, "https://acme.example.com");
    assert.deepEqual(config.services, ["core", "slack", "web-ui", "admin", "portal", "auth"]);
    assert.equal(config.env.core?.HARNESS, "pi");
    assert.equal(config.env.core?.AWS_DEPLOY_IMAGE, "acme-qm-sandbox");
    assert.equal(config.env.core?.AWS_PUBLIC_ORIGIN_URL, "http://replace-with-alb-hostname");
    assert.equal(config.env.slack?.SLACK_IDENTITY_EMAIL, "1");
    assert.equal(config.sandbox, undefined);
    assert.equal(config.aws?.cluster, "acme-qm");
    assert.equal(config.aws?.imageLabel, "latest");
    assert.deepEqual(config.aws?.services.core, {
      ecrRepository: "acme-qm-core",
      ecsService: "acme-qm-core",
      cpu: 2048,
      memory: 4096,
    });
    assert.deepEqual(Object.keys(config.aws?.services ?? {}), ["core", "web-ui", "admin", "portal", "auth"]);
    for (const name of ["main.tf", "outputs.tf", "variables.tf", "versions.tf", "terraform.tfvars"]) {
      assert.ok(existsSync(join(dir, "infra", name)), `infra/${name} is scaffolded`);
    }
    const tfvars = readFileSync(join(dir, "infra", "terraform.tfvars"), "utf8");
    assert.match(tfvars, /cluster_name\s*= "acme-qm"/);
    assert.match(tfvars, /github_repository\s*= "replace-me\/repository"/);
    assert.match(tfvars, /deploy_microvm_image\s*= "acme-qm-sandbox"/);
    assert.match(tfvars, /certificate_arn\s*= ""/);
    assert.match(readFileSync(join(dir, "infra", "main.tf"), "utf8"), /desired_count\s*= 0/);
    const env = readFileSync(join(dir, ".env.example"), "utf8").split("\n");
    for (const name of ["ADMIN_GRANTS=", "PUBLIC_API_URL=", "AUTH_ALLOWED_EMAILS=", "ANTHROPIC_API_KEY="]) {
      assert.ok(env.includes(name), `hosted AWS scaffold requires ${name}`);
    }
    for (const name of [
      "# OPENROUTER_API_KEY=  # optional",
      "# SLACK_BOT_TOKEN=  # optional",
      "# SLACK_APP_TOKEN=  # optional",
      "# AUTH_EMAIL_FROM=  # optional",
      "# RESEND_API_KEY=  # optional",
    ]) {
      assert.ok(env.includes(name), `hosted AWS scaffold offers deferred ${name}`);
    }
    const manifest = readFileSync(join(dir, "slack-app-manifest.yml"), "utf8");
    assert.match(manifest, /^ {2}name: qm$/m);
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /CloudFront/);
    assert.match(agents, /Lambda MicroVM/);
    for (const command of [
      "aws iam get-open-id-connect-provider",
      "aws iam create-open-id-connect-provider",
      "cloudfront_hostname",
      "alb_hostname",
      "npm exec qm -- infra render",
      "terraform -chdir=infra apply",
      "npm exec qm -- infra build-image",
      "npm exec qm -- secrets push",
      "npm exec qm -- up --yes",
      "npm exec qm -- check --live",
      "npm exec qm -- infra delete-task-definitions --yes",
      "secret_recovery_window_days=0",
    ]) {
      assert.match(agents, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(agents, /fly apps|sandbox publish|Fly app/);
    const destructiveApply = agents.indexOf("terraform -chdir=infra apply\n-var='ecr_force_delete=true'");
    const destructiveDestroy = agents.indexOf("terraform -chdir=infra destroy\n-var='ecr_force_delete=true'");
    assert.ok(destructiveApply >= 0, "destructive lifecycle settings are applied before teardown");
    const taskDefinitionCleanup = agents.indexOf("npm exec qm -- infra delete-task-definitions --yes");
    assert.ok(
      taskDefinitionCleanup > destructiveApply,
      "task definitions are cleaned after the lifecycle apply recreates its bootstrap revision",
    );
    assert.ok(destructiveDestroy > destructiveApply, "destroy follows the state-persisting apply");
    assert.ok(destructiveDestroy > taskDefinitionCleanup, "destroy follows task-definition cleanup");
    for (const setting of [
      "ecr_force_delete=true",
      "object_store_force_destroy=true",
      "db_skip_final_snapshot=true",
      "secret_recovery_window_days=0",
    ]) {
      assert.equal(agents.split(setting).length - 1, 2, `${setting} is passed to both apply and destroy`);
    }
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /infra\/\.terraform\//);
    assert.match(gitignore, /infra\/\*\.tfstate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init keeps long next-step commands separate from their explanations", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-"));
  try {
    const output = captureInit({ dir, org: "acme", target: "aws" });
    assert.match(output, /terraform -chdir=infra apply # create inert infrastructure/);
    assert.doesNotMatch(output, /apply#/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --target aws derives stable valid AWS names for a maximum-length org id", () => {
  const org = `a${"b".repeat(62)}`;
  const first = mkdtempSync(join(tmpdir(), "qm-init-long-"));
  const second = mkdtempSync(join(tmpdir(), "qm-init-long-"));
  try {
    quiet(() => runInit({ dir: first, org, target: "aws" }));
    quiet(() => runInit({ dir: second, org, target: "aws" }));
    const one = loadConfigInDir(first).config.aws!;
    const two = loadConfigInDir(second).config.aws!;
    assert.equal(one.cluster, two.cluster);
    assert.equal(one.cluster.length, 49);
    assert.match(one.cluster, /^[a-z][a-z0-9-]*[a-z0-9]$/);
    assert.equal(one.deployRoleArn, `arn:aws:iam::000000000000:role/${one.cluster}-github-deploy`);
    assert.equal(one.services.core?.ecsService, `${one.cluster}-core`);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("init refuses to clobber an existing config, and leaves present scaffold files untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-"));
  try {
    quiet(() => runInit({ dir, org: "acme" }));
    assert.throws(() => quiet(() => runInit({ dir, org: "acme" })), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init makes .env the final matching gitignore rule before generating signing keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-existing-ignore-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n!.env\n");
    quiet(() => runInit({ dir, org: "acme" }));
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n.env\n!.env\n.generated/\n.env\n");
    assert.match(readFileSync(join(dir, ".env"), "utf8"), /^CORE_SIGNING_SECRET=[a-f0-9]{64}$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init refuses to generate keys into an absent but Git-tracked .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-tracked-env-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".env"), "previous=value\n");
    execFileSync("git", ["add", ".env"], { cwd: dir, stdio: "ignore" });
    rmSync(join(dir, ".env"));
    assert.throws(() => quiet(() => runInit({ dir, org: "acme" })), /tracked by Git/);
    assert.ok(!existsSync(join(dir, CONFIG_FILENAME)), "init refuses before writing the scaffold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init refuses a present tracked .env before writing the scaffold", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-present-tracked-env-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".env"), "previous=value\n");
    execFileSync("git", ["add", ".env"], { cwd: dir, stdio: "ignore" });
    assert.throws(() => quiet(() => runInit({ dir, org: "acme" })), /tracked by Git/);
    assert.ok(!existsSync(join(dir, CONFIG_FILENAME)), "init refuses before writing the scaffold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init merges every AWS secret and generated-state ignore into an existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-aws-ignore-"));
  try {
    writeFileSync(join(dir, ".gitignore"), ".DS_Store\n");
    quiet(() => runInit({ dir, org: "acme", target: "aws" }));
    const rules = readFileSync(join(dir, ".gitignore"), "utf8").split(/\r?\n/);
    for (const rule of [
      "node_modules/",
      ".generated/",
      "infra/.terraform/",
      "infra/*.tfstate",
      "infra/*.tfstate.*",
      "infra/crash.log",
      "infra/*.tfplan",
    ])
      assert.ok(rules.includes(rule), `${rule} is ignored`);
    assert.equal(rules.filter(Boolean).at(-1), ".env", ".env is the final matching rule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init preflights package.json and completes an install-first package manifest", () => {
  const invalid = mkdtempSync(join(tmpdir(), "qm-init-invalid-package-"));
  const existing = mkdtempSync(join(tmpdir(), "qm-init-existing-package-"));
  try {
    writeFileSync(join(invalid, "package.json"), "{ broken");
    assert.throws(() => quiet(() => runInit({ dir: invalid, org: "acme" })), /package\.json is not valid JSON/);
    assert.ok(
      !existsSync(join(invalid, CONFIG_FILENAME)),
      "invalid package metadata cannot strand a partial deployment",
    );

    writeFileSync(
      join(existing, "package.json"),
      JSON.stringify({
        dependencies: { "qm-cli": "0.1.0", other: "1.0.0" },
      }),
    );
    quiet(() => runInit({ dir: existing, org: "acme" }));
    const manifest = JSON.parse(readFileSync(join(existing, "package.json"), "utf8")) as {
      private?: boolean;
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    assert.equal(manifest.private, true);
    assert.equal(manifest.engines?.node, ">=24.0.0");
    assert.equal(manifest.scripts?.deploy, "qm up");
    assert.equal(manifest.dependencies?.["@yc-software/qm"], cliVersion());
    assert.equal(manifest.dependencies?.["qm-cli"], undefined);
    assert.equal(manifest.dependencies?.other, "1.0.0");
  } finally {
    rmSync(invalid, { recursive: true, force: true });
    rmSync(existing, { recursive: true, force: true });
  }
});

test("init preserves an installed local package artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-local-package-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { "@yc-software/qm": "file:../packages/yc-software-qm-0.1.0.tgz" },
      }),
    );

    quiet(() => runInit({ dir, org: "acme", target: "fly" }));

    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(manifest.dependencies?.["@yc-software/qm"], "file:../packages/yc-software-qm-0.1.0.tgz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --target aws vendors a contract-valid Terraform deployment", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-aws-"));
  try {
    quiet(() => runInit({ dir, org: "globex", target: "aws" }));
    const { config } = loadConfigInDir(dir);
    assert.equal(config.aws?.cluster, "globex-qm");
    assert.equal(config.aws?.services.core?.cpu, 2048);
    for (const path of [
      ["infra", "versions.tf"],
      ["infra", "variables.tf"],
      ["infra", "main.tf"],
      ["infra", "outputs.tf"],
      ["infra", "terraform.tfvars"],
    ])
      assert.ok(existsSync(join(dir, ...path)), `${path.join("/")} exists`);
    assert.doesNotThrow(() => runChecks(config, dir, join(dir, "sandbox"), { report: false }));
    const main = readFileSync(join(dir, "infra", "main.tf"), "utf8");
    assert.match(main, /aws_ecs_cluster/);
    assert.match(main, /aws_db_instance/);
    assert.match(main, /aws_lb_listener/);
    assert.match(main, /aws_iam_openid_connect_provider/);
    assert.match(main, /aws_dynamodb_table/);
    assert.match(main, /ec2:DescribeSecurityGroups/);
    assert.match(main, /elasticloadbalancing:Describe\*/);
    assert.match(main, /servicediscovery:ListServices/);
    const tfvarsPath = join(dir, "infra", "terraform.tfvars");
    writeFileSync(
      tfvarsPath,
      readFileSync(tfvarsPath, "utf8").replace(
        /github_repository\s*= "replace-me\/repository"/,
        'github_repository   = "globex/deploy"',
      ),
    );
    config.publicUrl = "https://agents.globex.example";
    renderTerraformVars(config, dir);
    const tfvars = readFileSync(tfvarsPath, "utf8");
    assert.match(tfvars, /public_url\s*= "https:\/\/agents\.globex\.example"/);
    assert.match(tfvars, /github_repository\s*= "globex\/deploy"/);
    assert.ok(!existsSync(join(dir, ".github")), "init does not create deployment automation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scaffold is an npm-backed deployment repository with no CI coupling and valid Slack YAML", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-init-"));
  try {
    quiet(() => runInit({ dir, org: "acme" }));
    const packageJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      private?: boolean;
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.dependencies?.["@yc-software/qm"], cliVersion());
    assert.equal(packageJson.scripts?.check, "qm check");
    assert.ok(existsSync(join(dir, "deployment.md")));
    assert.ok(existsSync(join(dir, ".codex", "skills", "deploy-qm", "SKILL.md")));
    for (const provider of ["fly", "aws", "slack", "email"]) {
      assert.ok(existsSync(join(dir, ".codex", "skills", "deploy-qm", "references", `${provider}.md`)));
    }
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^node_modules\/$/m);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /package\.json.*pins the exact CLI version/s);
    assert.ok(!existsSync(join(dir, ".github")));
    assert.ok(!existsSync(join(dir, "test")));

    const manifest = readFileSync(join(dir, "slack-app-manifest.yml"), "utf8");
    assert.ok(!manifest.trimStart().startsWith("{"), "the .yml manifest holds YAML, not a JSON blob");
    assert.match(manifest, /^display_information:/m);
    assert.match(manifest, /^ {2}name: qm$/m);
    assert.match(manifest, /^ {6}- chat:write$/m);
    assert.match(manifest, /background_color: "#1f2937"/, "values YAML would misread are quoted");
    assert.deepEqual(
      slackManifestBotScopes(manifest),
      requiredSlackScopes(dir),
      "doctor parses the scaffolded YAML scopes",
    );
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
