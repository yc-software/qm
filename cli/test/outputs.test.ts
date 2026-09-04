import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { QmConfig } from "../src/config.ts";
import { deploymentOutputs, renderSlackFiles } from "../src/commands/outputs.ts";

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://qm.acme.example/",
  target: "fly",
  region: "sjc",
  flyOrg: "personal",
  services: ["core", "slack", "web-ui", "admin", "portal"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
};

const slackOidcConfig: QmConfig = {
  ...config,
  env: { portal: { OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize" } },
};

test("email-first outputs return the bot and web/admin URLs without advertising Slack SSO", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-outputs-"));
  try {
    renderSlackFiles(config, dir);
    const output = deploymentOutputs(config, dir);
    assert.equal(output.provider, "fly");
    assert.equal(output.providerAccountOrOrganization, "personal");
    assert.equal(output.region, "sjc");
    assert.equal(output.webUiUrl, "https://qm.acme.example");
    assert.equal(output.adminOnboardingUrl, "https://qm.acme.example/admin/onboarding");
    assert.equal(output.adminConnectorsUrl, "https://qm.acme.example/admin/connectors");
    assert.equal(output.userConnectionsUrl, "https://qm.acme.example/keychain");
    assert.equal(output.healthUrl, "https://qm.acme.example/healthz");
    assert.equal(output.slack.bot.manifest, join(dir, "slack-app-manifest.yml"));
    assert.equal(output.slack.sso, undefined);
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);

    const bot = new URL(output.slack.bot.createUrl);
    assert.equal(bot.origin + bot.pathname, "https://api.slack.com/apps");
    assert.equal(bot.searchParams.get("new_app"), "1");
    assert.match(bot.searchParams.get("manifest_yaml") ?? "", /name: qm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Slack OIDC outputs include the separate SSO app manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-outputs-"));
  try {
    renderSlackFiles(slackOidcConfig, dir);
    const output = deploymentOutputs(slackOidcConfig, dir);
    assert.equal(output.slack.sso?.signInUrl, "https://qm.acme.example/auth/login");
    assert.equal(output.slack.sso?.redirectUrl, "https://qm.acme.example/auth/callback");
    assert.equal(output.slack.sso?.manifest, join(dir, "slack-sso-manifest.yml"));
    const sso = new URL(output.slack.sso!.createUrl);
    assert.match(sso.searchParams.get("manifest_yaml") ?? "", /name: qm SSO/);
    assert.match(sso.searchParams.get("manifest_yaml") ?? "", /qm\.acme\.example\/auth\/callback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outputs rejects stale manifests and slack render repairs them", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-outputs-"));
  try {
    renderSlackFiles(slackOidcConfig, dir);
    writeFileSync(join(dir, "slack-app-manifest.yml"), "display_information:\n  name: stale-agent\n");
    assert.throws(() => deploymentOutputs(slackOidcConfig, dir), /do not match the current configuration/);

    renderSlackFiles(slackOidcConfig, dir);
    writeFileSync(
      join(dir, "slack-sso-manifest.yml"),
      "redirect_urls:\n  - https://wrong.example/?next=https://qm.acme.example/auth/callback\n",
    );
    assert.throws(() => deploymentOutputs(slackOidcConfig, dir), /do not match the current configuration/);

    renderSlackFiles(slackOidcConfig, dir);
    assert.match(readFileSync(join(dir, "slack-sso-manifest.yml"), "utf8"), /qm\.acme\.example\/auth\/callback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outputs requires the hosted user surfaces", () => {
  assert.throws(
    () => deploymentOutputs({ ...config, services: ["core"] }, "/tmp"),
    /requires the slack, web-ui, admin, and portal services/,
  );
});
