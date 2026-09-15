import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackRateLimitNotice } from "../src/slack/rate-limit-notice.ts";
import { slackAccountConfigsFromEnv, slackPluginConfigFromEnv } from "../src/slack/config.ts";

const rateLimit = { code: "slack_webapi_rate_limited_error", retryAfter: 59.1 };
const setupUrl = "https://qm.example/admin/?setup=slack";
const options = { managed: true, setupUrl };

function fixture() {
  const ephemeral: any[] = [];
  const messages: any[] = [];
  const client = {
    chat: {
      postEphemeral: async (args: any) => {
        ephemeral.push(args);
      },
      postMessage: async (args: any) => {
        messages.push(args);
      },
    },
    users: {
      lookupByEmail: async ({ email }: { email: string }) => {
        assert.equal(email, "reader@example.com");
        return { user: { id: "U2" } };
      },
    },
  };
  return { client, ephemeral, messages };
}

test("channel history failures notify requester in channel before a thread exists, once for partial failures", async () => {
  const { client, ephemeral, messages } = fixture();
  const notice = createSlackRateLimitNotice(options);
  await notice.run(client, { target: "C1:1700.1", user: "U1" }, async () => {
    await Promise.all([notice.observe(rateLimit), notice.observe(rateLimit)]);
    await notice.observe(rateLimit);
  });
  assert.equal(ephemeral.length, 1);
  assert.deepEqual(ephemeral[0], {
    channel: "C1",
    user: "U1",
    text: "Slack is temporarily limiting history reads, so I may be missing earlier context. Try again in 60 seconds, or <https://qm.example/admin/?setup=slack|set up your own Slack app>.",
  });
  assert.equal(messages.length, 0);
});

test("DM notice is a normal reply and concurrent channel requester stays isolated", async () => {
  const { client, ephemeral, messages } = fixture();
  const notice = createSlackRateLimitNotice(options);
  await Promise.all([
    notice.run(client, { target: "D1:1700.2", user: "U1" }, () => notice.observe(rateLimit)),
    notice.run(client, { target: "G1:1700.3", user: "reader@example.com" }, () => notice.observe(rateLimit)),
  ]);
  assert.equal(messages[0].channel, "D1");
  assert.equal(messages[0].thread_ts, "1700.2");
  assert.equal(ephemeral[0].channel, "G1");
  assert.equal(ephemeral[0].user, "U2");
  assert.equal(ephemeral[0].thread_ts, undefined);
});

test("no shared URL, unsafe setup URL, non429 and background requests stay quiet", async () => {
  const { client, ephemeral, messages } = fixture();
  for (const opts of [{ setupUrl }, { managed: true }, { managed: true, setupUrl: "http://qm.example" }]) {
    const notice = createSlackRateLimitNotice(opts);
    await notice.run(client, { target: "C1", user: "U1" }, () => notice.observe(rateLimit));
  }
  const notice = createSlackRateLimitNotice(options);
  await notice.observe(rateLimit);
  await notice.run(client, { target: "C1", user: "U1" }, async () => {
    await notice.observe(new Error("missing_scope"));
    await notice.run(client, undefined, () => notice.observe(rateLimit));
  });
  assert.equal(ephemeral.length + messages.length, 0);
});

test("notification failure does not replace history failure or retry repeatedly", async () => {
  const notice = createSlackRateLimitNotice(options);
  let posts = 0;
  const client = {
    chat: {
      postEphemeral: async () => {
        posts++;
        throw rateLimit;
      },
    },
  };
  await notice.run(client, { target: "C1", user: "U1" }, async () => {
    await notice.observe(rateLimit);
    await notice.observe(rateLimit);
  });
  assert.equal(posts, 1);
});

test("shared URL propagates for managed and own-app accounts without installation ID", () => {
  const env = { SLACK_BOT_TOKEN: "bot", SLACK_APP_TOKEN: "app", QM_SLACK_SERVICE_URL: "https://slack.example" };
  assert.equal(slackPluginConfigFromEnv(env)?.sharedServiceUrl, env.QM_SLACK_SERVICE_URL);
  const [account] = slackAccountConfigsFromEnv({
    ...env,
    SLACK_ACCOUNTS: JSON.stringify([{ id: "other", botToken: "bot2", appToken: "app2" }]),
  });
  assert.equal(account?.sharedServiceUrl, env.QM_SLACK_SERVICE_URL);
});

test("explicit read tools notify only for human Slack turns, using their original destination", async () => {
  const { createSurfaceToolDeps } = await import("../src/core/orchestrator/surface-tools.ts");
  for (const kind of ["human", "ambient", "automation"] as const) {
    const queries: any[] = [];
    const tools = createSurfaceToolDeps({
      deps: {
        deliveries: {},
        surfaceContext: {
          pull: async (_source: string, query: any) => {
            queries.push(query);
            return { messages: [] };
          },
        },
      },
      input: { surface: "slack", surfaceTools: true, origin: { kind }, background: true },
      actor: { id: "reader@example.com" },
      conversation: { kind: "channel" },
      defaultDestination: { type: "slack", target: "C1:1700.1" },
    } as any)!;
    await tools.readThread();
    await tools.whatsNew();
    await tools.search("needle");
    assert.equal(queries.length, 3);
    for (const query of queries)
      assert.deepEqual(
        query.rateLimitRecipient,
        kind === "human" ? { target: "C1:1700.1", user: "reader@example.com" } : undefined,
      );
  }
});

test("automatic and tool reads share a cooldown after normalizing the requester, without suppressing other people", async (t) => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { client, ephemeral } = fixture();
  const notice = createSlackRateLimitNotice(options);
  await notice.run(client, { target: "C1:1700.1", user: "U2" }, () => notice.observe(rateLimit));
  await notice.run(client, { target: "C1:1700.1", user: "reader@example.com" }, () => notice.observe(rateLimit));
  await notice.run(client, { target: "C1:1700.2", user: "U2" }, () => notice.observe(rateLimit));
  assert.equal(ephemeral.length, 1);
  await notice.run(client, { target: "C1:1700.1", user: "U1" }, () => notice.observe(rateLimit));
  await notice.run(client, { target: "C2:1700.1", user: "U2" }, () => notice.observe(rateLimit));
  assert.equal(ephemeral.length, 3);
  now += 60_001;
  await notice.run(client, { target: "C1:1700.1", user: "reader@example.com" }, () => notice.observe(rateLimit));
  assert.equal(ephemeral.length, 4);
});
