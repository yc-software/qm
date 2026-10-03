import { test } from "node:test";
import assert from "node:assert/strict";
import { updateSlackMessage } from "../src/slack/messaging.ts";
import { SLACK_TEXT_LIMIT } from "../src/slack/delivery.ts";

test("an over-limit edit is clipped without splitting a surrogate pair", async () => {
  let sent = "";
  const client = {
    chat: {
      async update(args: { text: string }) {
        sent = args.text;
      },
    },
  };
  const text = "a".repeat(SLACK_TEXT_LIMIT - 2) + "😀".repeat(10);
  await updateSlackMessage(client, "C1", "1.0", text);
  assert.ok(sent.length <= SLACK_TEXT_LIMIT);
  assert.ok(sent.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF]…$/.test(sent), "no lone high surrogate before the ellipsis");
});
