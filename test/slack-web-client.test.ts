import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebClient } from "@slack/web-api";
import { slackWebClient } from "../src/slack/web-client.ts";
import { errDetail } from "../plugins/chassis/src/errors.ts";

test("Slack transport errors retain diagnostic evidence without credentials or automatic resends", async (t) => {
  const token = "synthetic-slack-transport-token";
  let attempts = 0;
  const server = createServer((req) => {
    attempts++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    req.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const client = slackWebClient(token, (secret, options) => new WebClient(secret, { ...options, slackApiUrl: base }));
  await assert.rejects(client.apiCall("chat.postMessage", { channel: "C123", text: "Test" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(errDetail(error), /socket hang up|ECONNRESET/);
    assert.ok(!errDetail(error).includes(token));
    assert.ok(!JSON.stringify(error).includes(token));
    assert.equal((error as Error & { code: string }).code, "slack_webapi_request_error");
    return true;
  });
  assert.equal(attempts, 1);
});
