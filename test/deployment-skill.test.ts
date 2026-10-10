import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigAt } from "../cli/src/config.ts";
import { computedSecrets, serviceSecretValue } from "../cli/src/secrets.ts";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("package-consumer deployment skill covers supported hosting targets and the completion contract", () => {
  const root = read("cli/templates/deployment/deployment.md");
  for (const phrase of [
    "Before deployment changes",
    "local Docker, Fly.io, AWS, or Porter",
    "deployment repository",
    "npm ci",
    "slack render",
    "work-email OIDC provider",
    "check --live",
    "private live session canary",
    "fresh UUID",
    "generated sidebar title",
    "Web chat",
    "idempotent",
    "test-channel links",
    "adminConnectorsUrl",
    "adminOnboardingUrl",
    "userConnectionsUrl",
    "configured connectors",
  ]) {
    assert.ok(root.includes(phrase), `package deployment.md includes ${phrase}`);
  }
  assert.match(read("deployment.md"), /cli\/templates\/deployment\/deployment\.md/);
  for (const path of [
    ".codex/skills/deploy-qm/SKILL.md",
    ".codex/skills/deploy-qm/agents/openai.yaml",
    ".codex/skills/deploy-qm/references/fly.md",
    ".codex/skills/deploy-qm/references/aws.md",
    ".codex/skills/deploy-qm/references/porter.md",
    ".codex/skills/deploy-qm/references/slack.md",
    ".codex/skills/deploy-qm/references/email.md",
  ]) {
    assert.ok(existsSync(path), `${path} exists`);
  }
  assert.match(read(".codex/skills/deploy-qm/SKILL.md"), /\.\.\/\.\.\/\.\.\/deployment\.md/);
  for (const path of [
    "cli/templates/deployment/deployment.md",
    "cli/templates/deployment/SKILL.md",
    "cli/templates/deployment/references/fly.md",
    "cli/templates/deployment/references/aws.md",
    "cli/templates/deployment/references/porter.md",
    "cli/templates/deployment/references/slack.md",
    "cli/templates/deployment/references/email.md",
  ]) {
    assert.doesNotMatch(read(path), /QM_REPO|cli\/bin\/qm\.ts|fresh QM clone/);
  }
});

test("the deploy skill tells an agent where the sign-in email transport comes from", () => {
  const email = read("cli/templates/deployment/references/email.md");
  for (const phrase of [
    "AUTH_EMAIL_TRANSPORT",
    "resend.com/api-keys",
    "DNS",
    "SMTP_PORT",
    "SMTP_TLS",
    "AUTH_ALLOWED_EMAILS",
  ]) {
    assert.ok(email.includes(phrase), `email reference covers ${phrase}`);
  }
  assert.match(email, /operator — needs DNS control/, "the one step an agent cannot do itself is called out");
  assert.match(read("cli/templates/deployment/deployment.md"), /references\/email\.md/);
  for (const skill of [".codex/skills/deploy-qm/SKILL.md", "cli/templates/deployment/SKILL.md"]) {
    assert.match(read(skill), /references\/email\.md/, `${skill} routes the agent to the email reference`);
  }
  assert.match(
    read(".codex/skills/deploy-qm/references/email.md"),
    /cli\/templates\/deployment\/references\/email\.md/,
  );
});

test("the porter reference walks the dashboard steps an agent cannot skip", () => {
  const porter = read("cli/templates/deployment/references/porter.md");
  for (const phrase of [
    "dashboard.porter.run/cloud-accounts",
    "Admin-role",
    "PERMISSION_DENIED",
    "ADMIN_GRANTS",
    "AUTH_ALLOWED_EMAILS",
    "porter apply",
    "linux/amd64",
  ]) {
    assert.ok(porter.includes(phrase), `porter reference covers ${phrase}`);
  }
  assert.match(porter, /operator links one themselves/, "cloud-account linking is called out as the operator's step");
  assert.match(read("cli/templates/deployment/deployment.md"), /references\/porter\.md/);
  assert.match(
    read(".codex/skills/deploy-qm/references/porter.md"),
    /cli\/templates\/deployment\/references\/porter\.md/,
  );
});

test("connector onboarding is governed by the live admin-configured list", () => {
  const onboarding = read("plugins/onboarding/skills/onboarding/SKILL.md");
  const connectApps = read("skills-seed/connect-apps/SKILL.md");
  for (const skill of [onboarding, connectApps]) {
    assert.match(skill, /configured by (?:the |your )?admin/i);
    assert.doesNotMatch(skill, /Slack and Google first|Slack, Google, Notion, Linear, and GitHub/);
  }
  for (const skill of [onboarding, connectApps]) {
    assert.match(skill, /composio`? skill/);
    assert.match(skill, /never switch credentials to evade a denial/i);
    assert.doesNotMatch(skill, /If it says none are enabled, skip|offer none when that list is/);
  }
  assert.match(onboarding, /complete allowlist|same allowlist/);
  assert.doesNotMatch(onboarding, /machine-local credentials such as|`gh`, `glab`, or AWS/);
});

test("the source repository has no account-bound production deployment workflow", () => {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(existsSync);
  const retiredStack = ["qm", "deploy"].join("-");
  assert.ok(!files.some((file) => file.startsWith(`${retiredStack}/`)));
  const isPrivateMirror = files.some((file) => file.startsWith("deploy/layers/") && file !== "deploy/layers/README.md");
  if (!isPrivateMirror) {
    assert.ok(!files.includes(".github/workflows/deploy.yml"));
    assert.doesNotMatch(
      read(".github/workflows/cicd.yml"),
      /aws-actions\/configure-aws-credentials|flyctl deploy|qm up/,
    );
  }

  assert.ok(!files.some((file) => file.startsWith("cli/templates/workflows/")));
});

test("Slack distribution stays private and deployment-owned", () => {
  const slack = read("cli/templates/deployment/references/slack.md");
  assert.match(slack, /one private Socket Mode app per deployment and workspace/);
  assert.match(slack, /exact bot manifest creation URL/);
  assert.match(slack, /Admin Slack card/);
});

test("each provider has an independent agent-computer proof", () => {
  const root = read("cli/templates/deployment/deployment.md");
  const fly = read("cli/templates/deployment/references/fly.md");
  const aws = read("cli/templates/deployment/references/aws.md");

  assert.match(root, /\/root\/workspace\/qm-computer-proof\.txt/);
  assert.match(fly, /## Agent-computer proof/);
  assert.match(fly, /agent_scope/);
  assert.match(fly, /fly machine exec/);
  assert.match(aws, /## Agent-computer proof/);
  assert.match(aws, /deployment-owned S3 home\s+snapshot/);
  assert.match(aws, /workspace\/qm-computer-proof\.txt/);
});

test("onboarding composes existing access skills without a provider-setup prerequisite", () => {
  const onboarding = read("plugins/onboarding/skills/onboarding/SKILL.md");
  const admin = read("skills-seed/admin/SKILL.md");
  assert.ok(onboarding.indexOf("### Slack bot first") < onboarding.indexOf("### Personal connections"));
  assert.match(onboarding, /Reuse their connected accounts after checking identity and permissions/);
  assert.match(onboarding, /project key is not proof that a personal account is connected/);
  assert.match(onboarding, /skip account connection/);
  assert.match(onboarding, /help configure a new source only if they ask/);
  assert.match(onboarding, /never ask regular users to provision it/);
  assert.match(admin, /GET \/v1\/admin\/slack-installation/);
  assert.match(admin, /installAvailable: true/);
  assert.match(admin, /App Configuration Tokens/);
  assert.match(admin, /not the refresh token/);
  assert.match(admin, /manage other apps they own/);
  assert.match(admin, /then discards (?:it|the token)/);
  assert.match(admin, /Never paste it in chat, memory, files, or the keychain/);
  assert.match(admin, /Require a real reply before claiming the bot works/);
  assert.doesNotMatch(admin, /## Guide org OAuth app setup/);
});

test("onboarding includes the Slack configuration-token walkthrough", () => {
  const asset = "docs/images/slack-app-config-token-setup.gif";
  const skill = read("plugins/onboarding/skills/onboarding/SKILL.md");
  assert.ok(skill.includes(`https://raw.githubusercontent.com/yc-software/qm/main/${asset}`));
  assert.match(skill, /shows generation and copying/);
  assert.match(skill, /select their own workspace/);
  assert.match(skill, /secure setup\s+form, never into chat/);
  assert.equal(readFileSync(asset).subarray(0, 6).toString("ascii"), "GIF89a");
});

test("deployment onboarding offers password sign-in and a model gateway", () => {
  const deployment = read("cli/templates/deployment/deployment.md");
  assert.match(deployment, /email and password/);
  assert.match(deployment, /references\/sign-in\.md/);
  assert.match(deployment, /references\/model-gateway\.md/);
  for (const path of [".codex/skills/deploy-qm/SKILL.md", "cli/templates/deployment/SKILL.md"]) {
    assert.match(read(path), /references\/sign-in\.md/);
    assert.match(read(path), /references\/model-gateway\.md/);
  }
  const signIn = read("cli/templates/deployment/references/sign-in.md");
  assert.match(signIn, /AUTH_PASSWORD_USERS/);
  assert.match(signIn, /AUTH_ALLOWED_EMAILS/);
  assert.match(signIn, /ADMIN_GRANTS/);
  assert.match(signIn, /\/app\/src\/hash-password\.ts/);
  assert.doesNotMatch(signIn, /node plugins\/auth\/src/);
  const gateway = read("cli/templates/deployment/references/model-gateway.md");
  for (const name of [
    "MODEL_GATEWAY_URL",
    "MODEL_GATEWAY_API_KEY",
    "MODEL_GATEWAY_API_KEY_HEADER",
    "secretEnv",
    "Bearer",
    "gateway/",
    "check --live",
  ])
    assert.ok(gateway.includes(name), `gateway reference covers ${name}`);
  for (const name of ["sign-in", "model-gateway"]) {
    assert.ok(
      read(`.codex/skills/deploy-qm/references/${name}.md`).includes(`cli/templates/deployment/references/${name}.md`),
    );
  }
});

test("documented gateway config requires only a core gateway key, not direct provider keys", () => {
  const reference = read("cli/templates/deployment/references/model-gateway.md");
  const snippet = reference.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(snippet);
  const dir = mkdtempSync(join(tmpdir(), "qm-gateway-doc-"));
  try {
    const path = join(dir, "qm.config.jsonc");
    writeFileSync(
      path,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        ...JSON.parse(snippet[1]!),
      }),
    );
    const { config } = loadConfigAt(path);
    assert.equal(config.model, "gateway/my-chat-model");
    assert.equal(config.modelProvider, undefined);
    assert.equal(config.env.core?.HARNESS, "pi");
    const secrets = computedSecrets(config);
    const gateway = secrets.find((secret) => secret.name === "MODEL_GATEWAY_API_KEY");
    assert.ok(gateway?.required);
    assert.deepEqual(gateway.services, ["core"]);
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"])
      assert.ok(!secrets.find((secret) => secret.name === key)?.required);
    assert.equal(
      serviceSecretValue(
        config,
        "core",
        "MODEL_GATEWAY_API_KEY",
        new Map([["MODEL_GATEWAY_API_KEY", "Bearer test-router-key"]]),
      ),
      "Bearer test-router-key",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local Docker is a first-class onboarding target with honest acceptance checks", () => {
  const root = read("cli/templates/deployment/deployment.md");
  assert.match(root, /hosting target: local Docker, Fly.io, AWS, or Porter/);
  assert.match(root, /--target <docker-or-fly-or-aws>/);
  assert.match(root, /references\/docker\.md/);
  assert.doesNotMatch(root, /outside this\s+workflow|quick local test drive only/);
  for (const path of [".codex/skills/deploy-qm/SKILL.md", "cli/templates/deployment/SKILL.md"]) {
    assert.match(read(path), /local Docker/);
    assert.match(read(path), /references\/docker\.md/);
  }
  const docker = read("cli/templates/deployment/references/docker.md");
  for (const phrase of [
    "PUBLIC_API_URL",
    "host.docker.internal",
    "sandbox",
    "local",
    "portal",
    "auth",
    "8081",
    "Docker socket",
    "check --live",
    "not implemented",
    "qm.scope",
    "--purge",
  ])
    assert.ok(docker.includes(phrase), `Docker reference covers ${phrase}`);
  assert.match(
    read(".codex/skills/deploy-qm/references/docker.md"),
    /cli\/templates\/deployment\/references\/docker\.md/,
  );
});

test("documented Docker settings enable sign-in and local computers in a valid config", () => {
  const reference = read("cli/templates/deployment/references/docker.md");
  const snippet = reference.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(snippet);
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-doc-"));
  try {
    const path = join(dir, "qm.config.jsonc");
    writeFileSync(path, JSON.stringify({ contract: 1, orgId: "acme", target: "docker", ...JSON.parse(snippet[1]!) }));
    const { config } = loadConfigAt(path);
    assert.equal(config.sandbox?.backend, "local");
    assert.equal(config.publicUrl, "http://localhost:8081");
    assert.ok(config.services.includes("auth"));
    assert.ok(config.services.includes("admin"));
    const required = computedSecrets(config)
      .filter((secret) => secret.required)
      .map((secret) => secret.name);
    assert.ok(required.includes("ADMIN_GRANTS"));
    assert.ok(required.includes("PUBLIC_API_URL"));
    assert.ok(!required.some((name) => /^(FLY_|AWS_|SUPERSERVE_)/.test(name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
