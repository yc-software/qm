import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRequest } from "./support/fake-gateway.ts";
import { journeyTestOptions, waitFor } from "./support/journey-app.ts";
import type { SlackPost } from "./support/fake-slack.ts";
import { BOT_USER, startSlackJourney, type SlackJourney } from "./support/slack-journey.ts";

const ASKER = "U1ASKER";
const CHANNEL = "C1TEAM";
const DM = "D1ASKER";

let tsSeq = 0;
const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++tsSeq * 100).padStart(6, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function askedMarker(req: ModelRequest): string | undefined {
  return JSON.stringify(req.messages)
    .match(/ASK-[a-z0-9]+/g)
    ?.at(-1);
}

function answer(req: ModelRequest) {
  return { text: `Answer for ${askedMarker(req) ?? "nothing"}.` };
}

function silentWhenAllowed(req: ModelRequest) {
  const last = req.messages.at(-1);
  const answeringUser = last?.role === "user" && !JSON.stringify(last.content).includes('"tool_result"');
  return answeringUser && req.tools?.some((t) => t.name === "finish_silently")
    ? { tool: "finish_silently", input: { reason: "nothing to add" } }
    : answer(req);
}

function mention(marker: string, extra: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    user: ASKER,
    channel: CHANNEL,
    channel_type: "channel",
    text: `<@${BOT_USER}> can you check ${marker}?`,
    ts: nextTs(),
    ...extra,
  };
}

function dm(marker: string) {
  return { type: "message", user: ASKER, channel: DM, channel_type: "im", text: `quick one: ${marker}`, ts: nextTs() };
}

function postsFor(h: SlackJourney, channel: string, since: number): SlackPost[] {
  return h.slack.posts.slice(since).filter((p) => p.channel === channel);
}

async function onlyReply(h: SlackJourney, channel: string, since: number, marker: string): Promise<SlackPost> {
  await waitFor(async () => postsFor(h, channel, since).length > 0, `a reply to ${marker}`, 90_000);
  await sleep(3_000);
  const posts = postsFor(h, channel, since);
  assert.equal(posts.length, 1, `exactly one reply: ${JSON.stringify(posts.map((p) => p.text))}`);
  assert.match(posts[0]!.text ?? "", new RegExp(marker));
  return posts[0]!;
}

test("S1: a Slack mention or DM gets exactly one reply", journeyTestOptions(180_000), async (t) => {
  const h = await startSlackJourney((slack) => {
    slack.users.set(ASKER, { id: ASKER, name: "asker", email: "asker@example.com" });
    slack.channels.set(CHANNEL, { id: CHANNEL, name: "team" });
    slack.channels.set(DM, { id: DM, name: "", is_im: true });
    slack.dmFor.set(ASKER, DM);
  });
  h.app.gateway.respond = answer;
  const marker = () => `ASK-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await t.test("a channel mention, plus Slack's message copy of it, is answered once in its thread", async () => {
      const m = marker();
      const since = h.slack.posts.length;
      const event = mention(m);
      await h.deliver(event);
      await h.deliver({ ...event, type: "message" }, { eventId: `EvCopy${event.ts}` });
      const reply = await onlyReply(h, CHANNEL, since, m);
      assert.equal(reply.thread_ts, event.ts);
    });

    await t.test("a DM is answered once, top-level in the DM", async () => {
      const m = marker();
      const since = h.slack.posts.length;
      await h.deliver(dm(m));
      const reply = await onlyReply(h, DM, since, m);
      assert.equal(reply.thread_ts, undefined);
    });

    await t.test("Slack retrying a slow-acked mention does not produce a second reply", async () => {
      const m = marker();
      const since = h.slack.posts.length;
      const event = mention(m);
      await h.deliver(event);
      await h.deliver(event, { retryNum: 1, retryReason: "http_timeout" });
      await onlyReply(h, CHANNEL, since, m);
    });

    await t.test("a retry that arrives after a restart, once the reply is out, is not answered again", async () => {
      const m = marker();
      const since = h.slack.posts.length;
      const event = dm(m);
      await h.deliver(event);
      await onlyReply(h, DM, since, m);
      await h.restartPlugin();
      await h.deliver(event, { retryNum: 2, retryReason: "http_timeout" });
      await onlyReply(h, DM, since, m);
    });

    await t.test("a reply whose first post hits a Slack internal_error still lands exactly once", async () => {
      const m = marker();
      const since = h.slack.posts.length;
      h.slack.failNext.push({ method: "chat.postMessage", error: "internal_error" });
      const event = mention(m);
      await h.deliver(event);
      const reply = await onlyReply(h, CHANNEL, since, m);
      assert.equal(reply.thread_ts, event.ts);
    });

    await t.test("a reply whose first post is rate limited still lands exactly once", async () => {
      const m = marker();
      const since = h.slack.posts.length;
      h.slack.failNext.push({ method: "chat.postMessage", error: "ratelimited", status: 429 });
      await h.deliver(dm(m));
      await onlyReply(h, DM, since, m);
    });

    await t.test("a mention deep in a long channel's old thread is answered once in that thread", async () => {
      const base = Math.floor(Date.now() / 1000) - 30 * 86_400;
      const history: Array<{ user: string; text: string; ts: string; thread_ts?: string }> = Array.from(
        { length: 600 },
        (_, i) => ({
          user: i % 3 ? ASKER : "U9OTHER",
          text: `status update ${i}: shipped item ${i}`,
          ts: `${base + i * 60}.000100`,
        }),
      );
      const root = history[20]!.ts;
      for (let i = 0; i < 40; i++)
        history.push({ user: ASKER, text: `thread note ${i}`, ts: `${base + 1200 + i}.000200`, thread_ts: root });
      h.slack.history.set(CHANNEL, history);
      const m = marker();
      const since = h.slack.posts.length;
      await h.deliver(mention(m, { thread_ts: root }));
      const reply = await onlyReply(h, CHANNEL, since, m);
      assert.equal(reply.thread_ts, root);
      h.slack.history.delete(CHANNEL);
    });

    await t.test("a model that would rather stay silent still answers a DM", async () => {
      h.app.gateway.respond = silentWhenAllowed;
      const m = marker();
      const since = h.slack.posts.length;
      await h.deliver(dm(m));
      await onlyReply(h, DM, since, m);
    });

    await t.test("a model that would rather stay silent still answers a mention", async () => {
      h.app.gateway.respond = silentWhenAllowed;
      const m = marker();
      const since = h.slack.posts.length;
      const event = mention(m);
      await h.deliver(event);
      const reply = await onlyReply(h, CHANNEL, since, m);
      assert.equal(reply.thread_ts, event.ts);
    });

    await t.test("a mention answered with only a reaction gets that reaction on the message", async () => {
      h.app.gateway.respond = (req) => {
        const last = req.messages.at(-1);
        const answeringUser = last?.role === "user" && !JSON.stringify(last.content).includes('"tool_result"');
        return answeringUser ? { text: "[[react: eyes]]" } : answer(req);
      };
      const m = marker();
      const since = h.slack.posts.length;
      const calls = h.slack.calls.length;
      const event = mention(m);
      await h.deliver(event);
      await waitFor(
        async () =>
          h.slack.calls
            .slice(calls)
            .some((c) => c.method === "reactions.add" && c.args.timestamp === event.ts && c.args.name === "eyes"),
        `an eyes reaction on ${m}`,
        90_000,
      );
      await sleep(3_000);
      assert.deepEqual(postsFor(h, CHANNEL, since), []);
    });
  } finally {
    await h.stop();
  }
});
