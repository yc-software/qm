import assert from "node:assert/strict";
import { test } from "node:test";
import { slackPluginConfigFromEnv, storedSlackEnv } from "../src/slack/config.ts";

const deploymentEnv = {
  SLACK_BOT_TOKEN: "xoxb-deployment",
  SLACK_APP_TOKEN: "xapp-deployment",
  SLACK_USER_TOKEN: "xoxp-deployment",
  SLACK_COPILOT_BOT_TOKEN: "xoxb-copilot",
  SLACK_SIGNING_SECRET: "signing-secret",
  SLACK_ALLOW_FROM: "example.com",
  SLACK_IDENTITY_EMAIL: "1",
  SLACK_EVENTS_PORT: "3999",
  SLACK_HISTORY_LIMIT: "40",
};
const stored = { botToken: "xoxb-tenant", appToken: "xapp-tenant" };

test("a non-install tenant's Slack config drops the deployment's user, copilot and signing keys", () => {
  const config = slackPluginConfigFromEnv(storedSlackEnv(deploymentEnv, stored, false));
  assert.ok(config);
  assert.equal(config.botToken, "xoxb-tenant");
  assert.equal(config.appToken, "xapp-tenant");
  assert.equal(config.userToken, undefined);
  assert.equal(config.copilotBotToken, undefined);
  assert.equal(config.signingSecret, undefined);
  assert.equal(config.eventsPort, undefined);
  assert.equal(config.allowFrom, undefined);
  assert.equal(config.identityEmail, undefined);
  assert.equal(config.historyLimit, 40);
});

test("the install tenant keeps the deployment's Slack keys alongside its stored tokens", () => {
  const config = slackPluginConfigFromEnv(storedSlackEnv(deploymentEnv, stored, true));
  assert.ok(config);
  assert.equal(config.botToken, "xoxb-tenant");
  assert.equal(config.userToken, "xoxp-deployment");
  assert.equal(config.copilotBotToken, "xoxb-copilot");
  assert.equal(config.signingSecret, "signing-secret");
  assert.equal(config.eventsPort, 3999);
});
