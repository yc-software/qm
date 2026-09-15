import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebClient, LogLevel } from "@slack/web-api";
import { HISTORY_NO_RETRY } from "../src/slack/config.ts";
import { slackHistoryRateLimitMessage } from "../src/slack/history-rate-limit.ts";

test("managed history throttling gives retry timing and workspace app setup without leaking the error", () => {
  const message = slackHistoryRateLimitMessage(
    { code: "slack_webapi_rate_limited_error", retryAfter: 30, message: "private-token" },
    { managed: true, setupUrl: "https://qm.example/admin/?setup=slack" },
  );
  assert.match(message!, /Retry after 30 seconds/);
  assert.match(message!, /Earlier context may be incomplete/);
  assert.match(message!, /workspace admin/);
  assert.match(message!, /https:\/\/qm.example\/admin\/\?setup=slack/);
  assert.doesNotMatch(message!, /private-token/);
});

test("workspace-owned apps receive retry guidance without instructions to replace their app", () => {
  const message = slackHistoryRateLimitMessage({ code: "slack_webapi_rate_limited_error", retryAfter: 2.2 });
  assert.match(message!, /Retry after 3 seconds/);
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
    assert.match(message!, /QM's Slack settings/);
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
      assert.match(slackHistoryRateLimitMessage(error)!, /Retry after 60 seconds/);
      return true;
    });
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
