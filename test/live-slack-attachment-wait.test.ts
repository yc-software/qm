import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Ctx, DmHandle, type Env } from "./live-slack/harness.ts";
import { SlackClient, type SlackMessage } from "./live-slack/slack.ts";
import { scenarios } from "./live-slack/scenarios.ts";

function dmWithHistory(history: () => Promise<SlackMessage[]>): DmHandle {
  const qa = new SlackClient("synthetic-token", "http://127.0.0.1");
  qa.history = history;
  qa.getPermalink = async () => "https://example.test/message";
  const env = { qa, botUserId: "BOT" } as Env;
  return new DmHandle(new Ctx(env, { name: "attachment", lane: "dm", run: async () => {} }, 1), "DM");
}

const acknowledgement = { ts: "2", user: "BOT", text: "I'll create that file." };
const hasRequestedFile = (message: SlackMessage) =>
  message.files?.some((file) => file.name === "requested.txt") === true;

test("file waits ignore stable acknowledgements and unrelated files until the requested upload arrives", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const file: SlackMessage = { ts: "4", user: "BOT", files: [{ name: "requested.txt" }] };
  const dm = dmWithHistory(async () => [
    acknowledgement,
    { ts: "3", user: "BOT", files: [{ name: "unrelated.txt" }] },
    ...(Date.now() >= 110_000 ? [file] : []),
  ]);
  let settled = false;
  const result = dm.waitForBotReply("1", { timeoutMs: 20_000, accept: hasRequestedFile }).then((message) => {
    settled = true;
    return message;
  });
  await setImmediate();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(2500);
    await setImmediate();
  }
  assert.equal(settled, false);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(2500);
    await setImmediate();
  }
  assert.deepEqual(await result, file);
});

test("file waits fail at the deadline when only acknowledgements or another user's file arrive", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const dm = dmWithHistory(async () => [
    acknowledgement,
    { ts: "3", user: "OTHER", files: [{ name: "requested.txt" }] },
  ]);
  const rejected = assert.rejects(
    dm.waitForBotReply("1", { timeoutMs: 10_000, accept: hasRequestedFile }),
    /timed out after 10000ms/,
  );
  await setImmediate();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(2500);
    await setImmediate();
  }
  await rejected;
});

test("ordinary reply waits retain their existing stable-text behavior", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const dm = dmWithHistory(async () => [acknowledgement]);
  const result = dm.waitForBotReply("1", { timeoutMs: 10_000 });
  await setImmediate();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(2500);
    await setImmediate();
  }
  assert.deepEqual(await result, acknowledgement);
});

for (const evidence of ["none", "attachment", "slack-link", "markdown-link", "url"] as const) {
  test(`channel file scenario requires delivery evidence: ${evidence}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
    const scenario = scenarios.find((item) => item.name === "file-upload")!;
    const qa = new SlackClient("synthetic-token", "http://127.0.0.1");
    qa.createChannel = async () => "CHANNEL";
    qa.invite = async () => {};
    qa.post = async () => "1";
    qa.getPermalink = async () => "https://example.test/message";
    const ctx = new Ctx({ qa, botUserId: "BOT", runId: "attachment" } as Env, scenario, 1);
    const filename = `${ctx.marker()}.txt`;
    const payload: Partial<SlackMessage> = {};
    if (evidence === "attachment") payload.files = [{ name: filename }];
    else if (evidence === "slack-link") payload.text = `<https://example.test/download|${filename}>`;
    else if (evidence === "markdown-link") payload.text = `[${filename}](https://example.test/download)`;
    else payload.text = `https://example.test/${filename}`;
    qa.replies = async () => [
      { ts: "2", user: "BOT", text: `I'll create ${filename} now.` },
      ...(evidence !== "none" && Date.now() >= 110_000 ? [{ ts: "3", user: "BOT", ...payload }] : []),
    ];
    let settled = false;
    const run = scenario.run(ctx).then(() => {
      settled = true;
    });
    const result = evidence === "none" ? assert.rejects(run, /timed out/) : run;
    await setImmediate();
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(2500);
      await setImmediate();
    }
    assert.equal(settled, false);
    for (let i = 0; i < 130; i++) {
      t.mock.timers.tick(2500);
      await setImmediate();
    }
    await result;
    assert.equal(settled, evidence !== "none");
  });
}
