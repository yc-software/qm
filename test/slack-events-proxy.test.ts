import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SOURCE_SECRET = "source-auth-secret-for-slack-proxy-tests-0001";
const SLACK_SECRET = "slack-signing-secret-for-proxy-tests-0001";

let core: Server;
let receiver: Server;
let base: string;

before(async () => {
  receiver = createHttpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const timestamp = String(req.headers["x-slack-request-timestamp"] ?? "");
    const expected = `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const signature = req.headers["x-slack-signature"];
    const status = signature === expected ? 200 : 401;
    const payload =
      status === 200
        ? { challenge: (JSON.parse(body) as { challenge?: string }).challenge }
        : { error: "invalid_signature" };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));

  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "slack-events-proxy-")) }));
  core = createServer(built.app, {
    signingSecret: SOURCE_SECRET,
    slackEventsPort: (receiver.address() as AddressInfo).port,
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => core.close(() => resolve()));
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

function slackHeaders(body: string, secret = SLACK_SECRET): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  };
}

test("the public core endpoint proxies valid Slack events to the private receiver", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "proxy-ok" });
  const response = await fetch(`${base}/slack/events`, { method: "POST", headers: slackHeaders(body), body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: "proxy-ok" });
});

test("the private receiver remains the Slack-signature authority", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "nope" });
  const response = await fetch(`${base}/slack/events`, {
    method: "POST",
    headers: slackHeaders(body, "wrong-signing-secret-for-proxy-tests"),
    body,
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
});
