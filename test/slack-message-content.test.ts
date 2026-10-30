import assert from "node:assert/strict";
import test from "node:test";

import { slackMessageContent } from "../src/slack/message-content.ts";
import { amazonQAlarm, amazonQAlarmText } from "./support/slack-amazon-q-alarm.ts";

const file = (id: string, name: string) => ({
  id,
  name,
  mimetype: "text/plain",
  size: 4,
  url_private_download: `https://files.slack.com/files-pri/${id}/${name}`,
});

test("slackMessageContent labels forwarded text with its original author and channel", () => {
  const result = slackMessageContent({
    text: "please review",
    attachments: [
      {
        is_msg_unfurl: true,
        author_name: "Ada Lovelace",
        channel_name: "project-notes",
        text: "the original message",
      },
    ],
  });

  assert.equal(
    result.text,
    "please review\n[forwarded message from Ada Lovelace in #project-notes] the original message",
  );
  assert.deepEqual(result.files, []);
});

test("slackMessageContent carries files attached to a forwarded message", () => {
  const result = slackMessageContent({
    attachments: [
      {
        is_msg_unfurl: true,
        author_id: "UORIGINAL",
        author_name: "Grace Hopper",
        channel_name: "research",
        text: "supporting material",
        files: [file("F1", "notes.txt")],
      },
    ],
  });

  assert.equal(result.text, "[forwarded message from Grace Hopper in #research] supporting material");
  assert.deepEqual(result.files, [{ ...file("F1", "notes.txt"), user: "UORIGINAL" }]);
});

test("slackMessageContent recursively includes a nested forward", () => {
  const result = slackMessageContent({
    attachments: [
      {
        is_msg_unfurl: true,
        author_name: "outer author",
        channel_name: "outer-room",
        text: "outer message",
        message_blocks: [
          {
            message: {
              attachments: [
                {
                  is_msg_unfurl: true,
                  author_name: "inner author",
                  channel_name: "inner-room",
                  text: "inner message",
                  files: [file("F2", "nested.txt")],
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(
    result.text,
    "[forwarded message from outer author in #outer-room] outer message\n" +
      "[forwarded message from inner author in #inner-room] inner message",
  );
  assert.deepEqual(result.files, [file("F2", "nested.txt")]);
});

test("slackMessageContent renders attachment blocks and skips interactive payloads", () => {
  assert.deepEqual(slackMessageContent(amazonQAlarm), { text: amazonQAlarmText, files: [] });
});

test("slackMessageContent renders legacy attachment fields and falls back only when nothing else is readable", () => {
  const result = slackMessageContent({
    text: "top-level message",
    attachments: [
      {
        ts: "1787162400",
        pretext: "Build finished",
        title: "main #42",
        text: "legacy attachment",
        fields: [{ title: "Status", value: "failed" }],
        fallback: "fallback summary",
      },
      { fallback: "only a fallback" },
      {
        fallback: "[no preview available]",
        blocks: [
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Ack" }, value: "ack" }] },
        ],
      },
    ],
  });

  assert.equal(
    result.text,
    "top-level message\nBuild finished\nmain #42\nlegacy attachment\nStatus: failed\nonly a fallback",
  );
});

test("slackMessageContent renders top-level blocks only when the message has no text", () => {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "Deploy report" } },
    {
      type: "section",
      text: { type: "mrkdwn", text: "shipped by <@U1>" },
      fields: [{ type: "mrkdwn", text: "*env* prod" }],
    },
    {
      type: "context",
      elements: [
        { type: "image", image_url: "https://example.com/i.png", alt_text: "logo" },
        { type: "mrkdwn", text: "via CI" },
      ],
    },
    { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "shipped" }] }] },
  ];

  assert.equal(slackMessageContent({ text: "", blocks }).text, "Deploy report\nshipped by <@U1>\n*env* prod\nvia CI");
  assert.equal(slackMessageContent({ text: "shipped", blocks }).text, "shipped");
});

test("slackMessageContent leaves link previews out of the text", () => {
  const result = slackMessageContent({
    text: "see <https://example.com/post>",
    attachments: [
      {
        from_url: "https://example.com/post",
        original_url: "https://example.com/post",
        title: "Example post",
        text: "A long page description",
        fallback: "Example post",
      },
      { is_app_unfurl: true, app_unfurl_url: "https://tracker.example.com/T-1", title: "T-1", fallback: "Tracker" },
    ],
  });

  assert.equal(result.text, "see <https://example.com/post>");
});
