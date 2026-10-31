import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createSurfaceContextFulfiller } from "../src/slack/surface-context.ts";

async function searchWith(error: string, viewerToken?: string): Promise<unknown> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fulfilled: unknown[] = [];
  try {
    const f = createSurfaceContextFulfiller({
      core: { fulfillContextRequest: async (_id: string, outcome: unknown) => void fulfilled.push(outcome) } as never,
      directory: {} as never,
      serializer: {} as never,
      botToken: "xoxb-test",
      userToken: "xoxp-install",
      clientOptions: {
        slackApiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`,
        retryConfig: { retries: 0 },
      },
    });
    await f.fulfillSurfaceContext(
      {},
      {
        id: "r1",
        source: "slack",
        createdAt: Date.now(),
        status: "pending",
        query: { count: 5, searchAll: "launch", ...(viewerToken ? { viewerToken } : {}) },
      },
    );
  } finally {
    server.close();
  }
  return fulfilled[0];
}

test("a viewer token Slack rejects by auth error code reads as an unconnected live search", async () => {
  for (const code of ["invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed"]) {
    assert.deepEqual(await searchWith(code, "xoxp-viewer"), {
      result: { messages: [], liveSearch: "unconnected" },
    });
  }
});

test("other Slack errors, or an auth error on the install token, surface as search failures", async () => {
  assert.deepEqual(await searchWith("ratelimited_by_policy", "xoxp-viewer"), {
    error: "Slack search failed: An API error occurred: ratelimited_by_policy",
  });
  assert.deepEqual(await searchWith("invalid_auth"), {
    error: "Slack search failed: An API error occurred: invalid_auth",
  });
});

test("a channelId read refuses an externally shared channel and carries no thread when refused", async () => {
  const fulfilled: unknown[] = [];
  const f = createSurfaceContextFulfiller({
    core: { fulfillContextRequest: async (_id: string, outcome: unknown) => void fulfilled.push(outcome) } as never,
    directory: { getChannelInfo: async () => ({ is_ext_shared: true, is_member: true }) } as never,
    serializer: {} as never,
    botToken: "xoxb-test",
    clientOptions: {},
  });
  await f.fulfillSurfaceContext(
    {},
    {
      id: "r1",
      source: "slack",
      createdAt: Date.now(),
      status: "pending",
      query: { channelId: "CSHARED1", threadTs: "1.1" },
    },
  );
  assert.deepEqual(fulfilled, [{ error: "that channel is externally shared, so I won't read it" }]);
});

async function readWithThreadFailure(query: Record<string, unknown>, failure: unknown): Promise<unknown> {
  const fulfilled: unknown[] = [];
  const f = createSurfaceContextFulfiller({
    core: { fulfillContextRequest: async (_id: string, outcome: unknown) => void fulfilled.push(outcome) } as never,
    directory: { getChannelInfo: async () => ({ is_member: true }) } as never,
    serializer: {
      shapeRecentMessages: async (_c: unknown, raw: Array<{ ts: string; text: string }>) =>
        raw.map((m) => ({ ts: m.ts, text: m.text, name: "Ann" })),
    } as never,
    botToken: "xoxb-test",
    clientOptions: {},
    readHistory: async (_client, _channel, threadTs) => {
      if (threadTs) throw failure;
      return { raw: [{ ts: "1.1", text: "channel history" }], hasMore: false };
    },
  });
  await f.fulfillSurfaceContext({}, {
    id: "r1",
    source: "slack",
    createdAt: Date.now(),
    status: "pending",
    query,
  } as never);
  return fulfilled[0];
}

test("an explicit thread read that cannot fetch the thread is an error, throttle included", async () => {
  const throttled = { code: "slack_webapi_rate_limited_error", retryAfter: 60 };
  for (const failure of [new Error("thread_not_found"), throttled]) {
    for (const query of [
      { channelId: "C1", threadTs: "9.9" },
      { conversationTarget: "C1:9.9", threadTs: "9.9" },
    ]) {
      const outcome = (await readWithThreadFailure(query, failure)) as { error?: string };
      assert.ok(outcome.error, JSON.stringify(query));
    }
  }
});

test("a conversation-target pull without threadTs still returns the channel page when the thread fails", async () => {
  const outcome = (await readWithThreadFailure({ conversationTarget: "C1:9.9" }, new Error("thread_not_found"))) as {
    error?: string;
    result?: { messages: Array<{ text: string }> };
  };
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.result?.messages[0]?.text, "channel history");
});
