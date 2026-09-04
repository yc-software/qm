import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import { createHttpEventsReceiver, SLACK_EVENTS_PATH } from "../src/slack/http-events.ts";
import { normalizeSlackApiUrl, slackPluginConfigFromEnv } from "../src/slack/index.ts";

const SECRET = "test-signing-secret";

test("HTTP events mode trims the configured enum like the deployment secret gate", () => {
  const config = slackPluginConfigFromEnv({
    SLACK_EVENTS_MODE: "  http  ",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: SECRET,
  });
  assert.equal(config?.eventsMode, "http");
});

function sign(body: string, ts = Math.floor(Date.now() / 1000)): { signature: string; timestamp: string } {
  return {
    timestamp: String(ts),
    signature: `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
  };
}

async function withReceiver(
  processEvent: (event: ReceiverEvent) => Promise<void>,
  run: (
    post: (body: unknown, opts?: { badSig?: boolean; timestampOffsetSeconds?: number }) => Promise<Response>,
  ) => Promise<void>,
): Promise<void> {
  const receiver = createHttpEventsReceiver({ signingSecret: SECRET, port: 0, capMs: 500 });
  receiver.init?.({ processEvent } as unknown as BoltApp);
  await receiver.start(0 as never);
  const address = receiver.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const post = async (
    body: unknown,
    opts: { badSig?: boolean; timestampOffsetSeconds?: number } = {},
  ): Promise<Response> => {
    const raw = JSON.stringify(body);
    const { signature, timestamp } = sign(raw, Math.floor(Date.now() / 1000) + (opts.timestampOffsetSeconds ?? 0));
    return fetch(`http://127.0.0.1:${port}${SLACK_EVENTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": opts.badSig ? "v0=deadbeef" : signature,
      },
      body: raw,
    });
  };
  try {
    await run(post);
  } finally {
    await receiver.stop(0 as never);
  }
}

const messageEnvelope = {
  type: "event_callback",
  event_id: "Ev123",
  event: { type: "message", channel: "C1", ts: "1.1", user: "U1", text: "hi" },
};

test("rejects an unsigned/tampered POST with 401 without invoking the app", async () => {
  let processed = 0;
  await withReceiver(
    async () => {
      processed += 1;
    },
    async (post) => {
      assert.equal((await post(messageEnvelope, { badSig: true })).status, 401);
      assert.equal((await post(messageEnvelope, { timestampOffsetSeconds: -3600 })).status, 401);
      assert.equal((await post(messageEnvelope, { timestampOffsetSeconds: 3600 })).status, 401);
      assert.equal(processed, 0);
    },
  );
});

test("answers url_verification with the challenge", async () => {
  await withReceiver(
    async () => {},
    async (post) => {
      const res = await post({ type: "url_verification", challenge: "chal-123" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { challenge: "chal-123" });
    },
  );
});

test("gated message envelope: 200 is held until the handler persists", async () => {
  const order: string[] = [];
  await withReceiver(
    async (event) => {
      await event.ack();
      order.push("handler-done");
      (event.customProperties!.ackGate as { persisted(): void }).persisted();
    },
    async (post) => {
      const res = await post(messageEnvelope);
      order.push(`status-${res.status}`);
      assert.deepEqual(order, ["handler-done", "status-200"]);
    },
  );
});

test("handler failure before persistence answers 503 so the sender redelivers", async () => {
  await withReceiver(
    async (event) => {
      await event.ack();
      throw new Error("core enqueue failed");
    },
    async (post) => {
      assert.equal((await post(messageEnvelope)).status, 503);
    },
  );
});

test("non-gated envelopes ack immediately even while the handler is still running", async () => {
  let release: () => void = () => {};
  const blocked = new Promise<void>((r) => (release = r));
  await withReceiver(
    async (event) => {
      await event.ack();
      await blocked;
    },
    async (post) => {
      const res = await post({ type: "event_callback", event_id: "Ev9", event: { type: "reaction_added" } });
      assert.equal(res.status, 200);
      release();
    },
  );
});

test("normalizeSlackApiUrl accepts a host root or a full /api base", () => {
  assert.equal(normalizeSlackApiUrl("https://twin.example.com"), "https://twin.example.com/api/");
  assert.equal(normalizeSlackApiUrl("https://twin.example.com/"), "https://twin.example.com/api/");
  assert.equal(normalizeSlackApiUrl("https://twin.example.com/api"), "https://twin.example.com/api/");
  assert.equal(normalizeSlackApiUrl("https://twin.example.com/api/"), "https://twin.example.com/api/");
  assert.equal(normalizeSlackApiUrl("https://slack.com/api/"), "https://slack.com/api/");
});
