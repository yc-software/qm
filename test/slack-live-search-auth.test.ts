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
