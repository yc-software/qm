import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("package-consumer deployment skill covers both self-owned providers and the completion contract", () => {
  const root = read("cli/templates/deployment/deployment.md");
  for (const phrase of [
    "Before cloud mutation",
    "Fly.io, AWS, or Porter",
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
    assert.match(skill, /skill:\/\/composio\/SKILL\.md/);
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
