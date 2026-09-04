import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { slackBotManifestCreationUrl } from "../src/surfaces/slack-manifest.ts";

const manifestFromUrl = (
  url: string,
): { display_information: { name: string }; features: { bot_user: { display_name: string } } } =>
  JSON.parse(new URL(url).searchParams.get("manifest_json") ?? "{}");

test("the admin Slack app creation link defaults to qm and adopts a configured name", () => {
  const dflt = manifestFromUrl(slackBotManifestCreationUrl());
  assert.equal(dflt.display_information.name, "qm");
  assert.equal(dflt.features.bot_user.display_name, "qm");

  const named = manifestFromUrl(slackBotManifestCreationUrl("straylight"));
  assert.equal(named.display_information.name, "straylight");
  assert.equal(named.features.bot_user.display_name, "straylight");

  const long = manifestFromUrl(slackBotManifestCreationUrl("x".repeat(40)));
  assert.equal(long.display_information.name.length, 35);
});

test("membership events invalidate the pushed authorization roster", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/slack/manifest.json", import.meta.url), "utf8")) as {
    settings?: { event_subscriptions?: { bot_events?: string[] } };
  };
  const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert.ok(events.includes("member_joined_channel"));
  assert.ok(events.includes("member_left_channel"));
});
