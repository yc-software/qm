import assert from "node:assert/strict";
import test from "node:test";

import { messageWithForwardedContent } from "../src/slack/forwards.ts";
import { slackMessageToIngestEvent } from "../src/slack/mirror.ts";
import { parseMessageEvent } from "../src/slack/payloads.ts";
import { withRichContent } from "../src/slack/rich-content.ts";
import type { BotIdentity } from "../src/slack/directory.ts";

const ids = { botUserId: "UBOT", ownBotId: "BBOT" } as BotIdentity;

const alarmBlocks = [
  { type: "section", text: { type: "mrkdwn", text: "*CloudWatch Alarm | core-5xx | us-west-2*" } },
  { type: "divider" },
  {
    type: "section",
    text: { type: "mrkdwn", text: "Threshold Crossed" },
    fields: [{ type: "mrkdwn", text: "*State*\nALARM" }],
  },
  { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Query logs" } }] },
  {
    type: "context",
    elements: [
      { type: "mrkdwn", text: "Account: 123" },
      { type: "image", image_url: "x" },
    ],
  },
];
const expected = "*CloudWatch Alarm | core-5xx | us-west-2*\nThreshold Crossed\n*State*\nALARM\nAccount: 123";

test("Amazon Q alarm posts (blank text, blocks inside an attachment) are mirrored with readable text", () => {
  const alarm = { channel: "CDEV", ts: "1.1", bot_id: "BAWS", text: "", attachments: [{ id: 1, blocks: alarmBlocks }] };
  assert.equal(slackMessageToIngestEvent(parseMessageEvent(alarm), ids).text, expected);
});

test("top-level header and section blocks render when text is blank", () => {
  const blocks = [{ type: "header", text: { type: "plain_text", text: "Deploy" } }, ...alarmBlocks];
  assert.equal(withRichContent({ text: "", blocks }), `Deploy\n${expected}`);
});

test("legacy attachments render title, text and fields, else fallback; forwards are left to forwards.ts", () => {
  const result = messageWithForwardedContent({
    text: "",
    attachments: [
      { pretext: "Alarm", title: "core-5xx", text: "Threshold crossed", fields: [{ title: "State", value: "ALARM" }] },
      { fallback: "only fallback" },
      { is_share: true, author_name: "Ada", channel_name: "ops", text: "original" },
    ],
  } as Parameters<typeof messageWithForwardedContent>[0]);
  assert.equal(
    result.text,
    "Alarm\ncore-5xx\nThreshold crossed\nState: ALARM\nonly fallback\n[forwarded message from Ada in #ops] original",
  );
});

test("messages with text are unchanged and derived text is capped", () => {
  assert.equal(withRichContent({ text: "hi", blocks: alarmBlocks, attachments: [{ text: "x" }] }), "hi");
  const long = withRichContent({ blocks: [{ type: "markdown", text: "x".repeat(10_000) }] });
  assert.equal(long.length, 4_001);
});
