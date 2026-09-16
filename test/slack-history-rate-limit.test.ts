import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebClient, LogLevel } from "@slack/web-api";
import { HISTORY_NO_RETRY, slackPluginConfigFromEnv, slackAccountConfigsFromEnv } from "../src/slack/config.ts";
import { slackHistoryRateLimitMessage } from "../src/slack/history-rate-limit.ts";

test("managed history throttling gives retry timing and workspace app setup without leaking the error", () => {
  const message = slackHistoryRateLimitMessage(
    { code: "slack_webapi_rate_limited_error", retryAfter: 30, message: "private-token" },
    { managed: true, setupUrl: "https://qm.example/admin/?setup=slack" },
  );
  assert.match(message!, /Try again in 30 seconds/);
  assert.match(message!, /I may be missing earlier context/);
  assert.doesNotMatch(message!, /workspace admin|ask an admin/);
  assert.match(message!, /https:\/\/qm.example\/admin\/\?setup=slack/);
  assert.doesNotMatch(message!, /private-token/);
});

test("workspace-owned apps receive retry guidance without instructions to replace their app", () => {
  const message = slackHistoryRateLimitMessage({ code: "slack_webapi_rate_limited_error", retryAfter: 2.2 });
  assert.match(message!, /Try again in 3 seconds/);
  assert.doesNotMatch(message!, /set up|workspace-owned/);
});

test("unrelated errors do not suggest changing Slack apps", () => {
  for (const error of [null, "rate limited", new Error("429"), { data: { error: "missing_scope" } }]) {
    assert.equal(slackHistoryRateLimitMessage(error, { managed: true }), undefined);
  }
});

test("malformed delay and unsafe setup URLs use plain guidance", () => {
  for (const setupUrl of ["javascript:alert(1)", "https://user:secret@qm.example/admin/", "invalid"]) {
    const message = slackHistoryRateLimitMessage(
      { data: { error: "ratelimited" }, retryAfter: "invalid" },
      { managed: true, setupUrl },
    );
    assert.match(message!, /Try again shortly/);
    assert.doesNotMatch(message!, /set up/);
    assert.doesNotMatch(message!, /javascript|secret|NaN/);
  }
});

test("Slack history 429 returns immediately instead of sleeping inside the SDK", { timeout: 5000 }, async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(429, { "retry-after": "60", "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new WebClient("test-token", {
    ...HISTORY_NO_RETRY,
    slackApiUrl: `http://127.0.0.1:${address.port}/api/`,
    logLevel: LogLevel.ERROR,
  });
  try {
    await assert.rejects(client.conversations.history({ channel: "C1" }), (error: unknown) => {
      assert.match(slackHistoryRateLimitMessage(error)!, /Try again in 60 seconds/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const source of ["live", "shadow", "mirror"] as const) {
  for (const { managed, historyLimit } of [
    { managed: false },
    { managed: true },
    { managed: false, historyLimit: 15 },
    { managed: true, historyLimit: 200 },
  ]) {
    test(`${source} history uses the ${managed ? "shared" : "workspace-owned"} app page size (override ${historyLimit ?? "unset"})`, async () => {
      const { createSlackHistoryReader } = await import("../src/slack/history.ts");
      const calls: Array<{ method: string; args: any }> = [];
      const client = {
        conversations: Object.fromEntries(
          ["history", "replies"].map((method) => [
            method,
            async (args: any) => {
              calls.push({ method, args });
              return { messages: [{ ts: "1.0", text: "parent", reply_count: 1 }], has_more: true };
            },
          ]),
        ),
      };
      const reader = createSlackHistoryReader({
        core: {} as import("../src/api/slack-core-client.ts").SlackCoreClient,
        ids: { botUserId: "UBOT", ownBotId: "BBOT" } as import("../src/slack/directory.ts").BotIdentity,
        source,
        managed,
        historyLimit,
      });
      const channel = await reader(client, "C1", undefined, "10.0", true);
      const thread = await reader(client, "C1", "1.0");
      assert.equal(calls.length, source === "mirror" ? 2 : 3);
      assert.ok(calls.some((call) => call.method === "history"));
      assert.ok(calls.some((call) => call.method === "replies"));
      assert.ok(calls.every((call) => call.args.limit === (managed ? 15 : (historyLimit ?? 200))));
      assert.equal(calls[0]!.args.latest, "10.0");
      assert.equal(calls[0]!.args.inclusive, false);
      for (const page of [channel, thread]) {
        assert.equal(page.hasMore, true);
        assert.equal(
          page.note,
          source === "mirror" ? "Slack history is truncated; older messages may be absent." : undefined,
        );
      }
    });
  }
}

for (const { managed, historyLimit } of [
  { managed: false },
  { managed: true },
  { managed: false, historyLimit: 15 },
  { managed: true, historyLimit: 200 },
]) {
  test(`surface history defaults for ${managed ? "shared" : "workspace-owned"} apps (override ${historyLimit ?? "unset"})`, async () => {
    const { createSurfaceContextFulfiller } = await import("../src/slack/surface-context.ts");
    let outcome: any;
    const calls: any[] = [];
    const client = {
      conversations: Object.fromEntries(
        ["history", "replies"].map((method) => [
          method,
          async (args: any) => {
            calls.push(args);
            return {
              messages: Array.from({ length: Math.min(args.limit, 15) }, (_, i) => ({
                ts: String((method === "history" ? 100 : 200) + i),
                text: `message ${i}`,
                user: "U1",
              })),
              has_more: true,
            };
          },
        ]),
      ),
    };
    const fulfiller = createSurfaceContextFulfiller({
      core: {
        fulfillContextRequest: async (_id: string, result: unknown) => {
          outcome = result;
        },
      } as unknown as import("../src/api/slack-core-client.ts").SlackCoreClient,
      directory: {} as import("../src/slack/directory.ts").Directory,
      serializer: {
        shapeRecentMessages: async (_client: unknown, raw: any[]) => raw.map((m) => ({ ...m, name: "Alice" })),
      } as unknown as import("../src/slack/conversation-view.ts").ConversationSerializer,
      botToken: "test",
      clientOptions: {},
      historyRateLimitOptions: { managed },
      historyLimit,
    });
    const query = { conversationTarget: "C1:1.0" };
    await fulfiller.fulfillSurfaceContext(client, {
      id: "test",
      query,
    } as import("../src/api/slack-core-client.ts").SurfaceContextRequest);
    assert.equal(outcome.result.messages.length, managed ? 15 : (historyLimit ?? 30));
    assert.equal(outcome.result.hasMore, true);
    assert.ok(outcome.result.nextBefore);
    assert.ok(calls.every((args) => args.limit === (managed ? 15 : (historyLimit ?? 200))));
    assert.equal(outcome.result.note, undefined);
    await fulfiller.fulfillSurfaceContext(client, {
      id: "test",
      query: { ...query, count: 5 },
    } as import("../src/api/slack-core-client.ts").SurfaceContextRequest);
    assert.equal(outcome.result.messages.length, 5);
  });
}

test("history limit configuration is optional, validated, and inherited by additional accounts", () => {
  const env = { SLACK_BOT_TOKEN: "test", SLACK_APP_TOKEN: "test" };
  assert.equal(slackPluginConfigFromEnv(env)?.historyLimit, undefined);
  assert.equal(slackPluginConfigFromEnv({ ...env, SLACK_HISTORY_LIMIT: "15" })?.historyLimit, 15);
  for (const value of ["0", "201", "1.5", "nope", "Infinity"]) {
    assert.throws(() => slackPluginConfigFromEnv({ ...env, SLACK_HISTORY_LIMIT: value }), /SLACK_HISTORY_LIMIT/);
  }
  const accounts = slackAccountConfigsFromEnv({
    ...env,
    SLACK_HISTORY_LIMIT: "15",
    SLACK_ACCOUNTS: JSON.stringify([{ id: "extra", botToken: "other", appToken: "other" }]),
  });
  assert.equal(accounts.length, 1);
  assert.ok(accounts.every((account) => account.historyLimit === 15));
});
