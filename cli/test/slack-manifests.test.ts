import { test } from "node:test";
import assert from "node:assert";
import { renderSlackManifests, usesSlackOidc } from "../src/slack-manifests.ts";
import type { QmConfig } from "../src/config.ts";

function configWithPortalEnv(env: Record<string, string>): QmConfig {
  return { env: { portal: env } } as unknown as QmConfig;
}

test("usesSlackOidc matches by hostname, not substring", () => {
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://slack.com" })), true);
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://enterprise.slack.com" })), true);
  assert.equal(
    usesSlackOidc(configWithPortalEnv({ OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize" })),
    true,
  );
  // substring lookalikes must not count as Slack
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://not-slack.com.example/idp" })), false);
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://evil-slack.com/auth" })), false);
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://slack.com.evil.example" })), false);
  // malformed values fail closed
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "slack.com" })), false);
  assert.equal(usesSlackOidc(configWithPortalEnv({})), false);
});

test("Slack manifest branding comes from the deployment environment", () => {
  const config = {
    botName: "Acme Agent",
    orgId: "acme",
    publicUrl: "https://agent.example.com",
    env: {
      slack: {
        SLACK_APP_DESCRIPTION: "Acme private workspace agent",
        SLACK_AGENT_DESCRIPTION: "Your Acme teammate",
        SLACK_BACKGROUND_COLOR: "#123abc",
      },
    },
  } as unknown as QmConfig;
  const manifest = renderSlackManifests(config).bot;
  assert.match(manifest, /description: Acme private workspace agent/);
  assert.match(manifest, /agent_description: Your Acme teammate/);
  assert.match(manifest, /background_color: "#123abc"/);
});

test("Slack manifest branding rejects invalid colors", () => {
  const config = {
    botName: "Acme Agent",
    orgId: "acme",
    publicUrl: "https://agent.example.com",
    env: { slack: { SLACK_BACKGROUND_COLOR: "blue" } },
  } as unknown as QmConfig;
  assert.throws(() => renderSlackManifests(config), /six-digit hex color/);
});

test("Slack manifest branding rejects descriptions over Slack limits", () => {
  const config = {
    botName: "Acme Agent",
    orgId: "acme",
    publicUrl: "https://agent.example.com",
    env: { slack: { SLACK_APP_DESCRIPTION: "a".repeat(141), SLACK_AGENT_DESCRIPTION: "b".repeat(301) } },
  } as unknown as QmConfig;
  assert.throws(() => renderSlackManifests(config), /at most 140 characters/);
  config.env.slack!.SLACK_APP_DESCRIPTION = "valid";
  assert.throws(() => renderSlackManifests(config), /at most 300 characters/);
});
