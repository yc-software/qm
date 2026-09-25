import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");

test("project detail offers a Slack home-channel section", () => {
  assert.match(source, /function projectSlackSection\(/);
  assert.match(source, /c\.project \? projectSlackSection\(c\) : nothing/);
  assert.match(source, /Link a channel/);
});

test("the slack-channel input keeps focus across redraws and commits to state", () => {
  const input = source.match(/<input\s+type="text"\s+data-focus-key="project-slack-channel"[^]*?\/>/)?.[0] ?? "";
  assert.match(input, /\.value=\$\{contextsState\.slackValue\}/);
  assert.match(input, /contextsState\.slackValue = \(e\.target as HTMLInputElement\)\.value/);
});

test("link and unlink go through the project slack-channel API and refresh the project view", () => {
  assert.match(source, /\/slack-channel`, \{\s*method: "PUT"/);
  assert.match(source, /\/slack-channel`, \{\s*method: "DELETE"/);
  const link = source.match(/async function linkProjectSlackChannel[^]*?\n\}/)?.[0] ?? "";
  const unlink = source.match(/async function unlinkProjectSlackChannel[^]*?\n\}/)?.[0] ?? "";
  for (const fn of [link, unlink]) {
    assert.match(fn, /projectFromResponse\(/);
    assert.match(fn, /upsertProject\(/);
  }
  assert.match(unlink, /window\.confirm/);
});

test("the web-ui server proxies slack-channel link routes to core with the signed-in principal", () => {
  const routes = [
    ...server.matchAll(/method: "(PUT|DELETE)",\s+path: "\/api\/projects\/:id\/slack-channel"[^]*?\n {2}\},/g),
  ];
  assert.equal(routes.length, 2, "one PUT and one DELETE slack-channel route");
  const put = routes.find((m) => m[1] === "PUT")?.[0] ?? "";
  const del = routes.find((m) => m[1] === "DELETE")?.[0] ?? "";
  assert.match(put, /"PUT",\s*`\/v1\/projects\/\$\{encodeURIComponent\(id\)\}\/slack-channel`/);
  assert.match(del, /"DELETE",\s*`\/v1\/projects\/\$\{encodeURIComponent\(id\)\}\/slack-channel`/);
  assert.match(put, /JSON\.stringify\(\{ principalId: user, channel \}\)/);
});

test("CoreProject carries the linked slack channel", () => {
  assert.match(
    bridge,
    /slackChannel\?: \{ channelId: string; channelName: string; linkedBy\?: string; linkedAt\?: number \}/,
  );
});

test("channel-derived members are badged and not removable", () => {
  assert.match(source, /viaChannel = Boolean\(/);
  assert.match(source, /principalId !== project\.ownerId && !viaChannel/);
  assert.match(source, /Joined via the linked Slack channel/);
});

test("hint copy says the agent posts there and membership follows the channel", () => {
  assert.match(source, /everyone in the channel joins\s+the project/);
  assert.match(source, /everyone in the channel is in the project/);
});
