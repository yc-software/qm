import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ChannelHandle, Ctx, type Env } from "./live-slack/harness.ts";
import { SlackClient, type SlackMessage } from "./live-slack/slack.ts";

test("file uploads preserve binary bytes and thread metadata", async (t) => {
  const bytes = readFileSync(new URL("./live-slack/fixtures/taylor-selfie.png", import.meta.url));
  let uploaded = Buffer.alloc(0);
  let metadata: Record<string, string> = {};
  let contentType = "";
  let uploadLength = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const form = new URLSearchParams(body.toString());
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/files.getUploadURLExternal") {
      uploadLength = form.get("length") ?? "";
      res.end(JSON.stringify({ ok: true, file_id: "F1", upload_url: `${base}/upload` }));
    } else if (req.url === "/upload") {
      uploaded = body;
      contentType = req.headers["content-type"] ?? "";
      res.end("{}");
    } else if (req.url === "/api/files.completeUploadExternal") {
      metadata = Object.fromEntries(form);
      res.end(JSON.stringify({ ok: true, files: [{ id: "F1" }] }));
    } else if (req.url === "/api/conversations.replies") {
      res.end(JSON.stringify({ ok: true, messages: [{ ts: "2", files: [{ id: "F1" }] }] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const client = new SlackClient("test-token", base);
  assert.equal(
    await client.uploadFile("C1", {
      filename: "portrait.png",
      bytes,
      title: "Portrait",
      initialComment: "A teammate",
      threadTs: "1",
    }),
    "2",
  );
  assert.deepEqual(uploaded, bytes);
  assert.equal(contentType, "application/octet-stream");
  assert.equal(uploadLength, String(bytes.length));
  assert.equal(metadata.channel_id, "C1");
  assert.equal(metadata.thread_ts, "1");
  assert.equal(metadata.initial_comment, "A teammate");
  assert.deepEqual(JSON.parse(metadata.files!), [{ id: "F1", title: "Portrait" }]);
});

for (const [name, includeChannel, expected, threadTs] of [
  ["channel questions accept a top-level answer without a marker", true, "3", undefined],
  ["channel questions accept an answer that has become a thread parent", true, "3", "3"],
  ["thread questions still require a reply in their own thread", false, "5", undefined],
] as const) {
  test(name, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
    const threadReply: SlackMessage = { ts: "5", user: "BOT", text: "A thread answer", thread_ts: "2" };
    let polls = 0;
    const qa = {
      replies: async () => (++polls > 3 ? [threadReply] : []),
      history: async () => [
        { ts: "1", user: "BOT", text: "An older answer" },
        { ts: "2.5", user: "HUMAN", text: "An unrelated human" },
        { ts: "2.7", user: "BOT", text: "A different thread", thread_ts: "0" },
        { ts: "2.9", user: "BOT", text: "Thinking… ▌" },
        { ts: "3", user: "BOT", text: "Mars is the Red Planet.", thread_ts: threadTs },
      ],
      getPermalink: async () => undefined,
    };
    const ctx = new Ctx({ qa, botUserId: "BOT" } as unknown as Env, { name, lane: "parallel", run: async () => {} }, 1);
    const channel = new ChannelHandle(ctx, "C1", "test-channel");
    const waiting = channel.waitForBotReply("2", { includeChannel, timeoutMs: 30_000 });
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      t.mock.timers.tick(2500);
    }
    assert.equal((await waiting).ts, expected);
    assert.ok(ctx.timeline.botMessages().some((message) => message.ts === expected));
  });
}

test("history lookup waits beyond a progress message for the requested fact", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const progress = { ts: "3", user: "BOT", text: "I'll look back through the channel history." };
  const answer = { ts: "4", user: "BOT", text: "The launch name is Aurora-a1b2c3d4." };
  let polls = 0;
  const qa = {
    replies: async () => [],
    history: async () => (++polls > 4 ? [progress, answer] : [progress]),
    getPermalink: async () => undefined,
  };
  const ctx = new Ctx(
    { qa, botUserId: "BOT" } as unknown as Env,
    {
      name: "history",
      lane: "parallel",
      run: async () => {},
    },
    1,
  );
  const waiting = new ChannelHandle(ctx, "C1", "test-channel").waitForBotReply("2", {
    includeChannel: true,
    match: /Aurora-a1b2c3d4/i,
    timeoutMs: 30_000,
  });
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 10; j++) await Promise.resolve();
    t.mock.timers.tick(2500);
  }
  assert.equal((await waiting).ts, "4");
  assert.deepEqual(
    ctx.timeline.botMessages().map((message) => message.ts),
    ["3", "4"],
  );
});
