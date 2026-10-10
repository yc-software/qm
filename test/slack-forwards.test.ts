import assert from "node:assert/strict";
import test from "node:test";

import { messageWithForwardedContent } from "../src/slack/forwards.ts";

const file = (id: string, name: string) => ({
  id,
  name,
  mimetype: "text/plain",
  size: 4,
  url_private_download: `https://files.slack.com/files-pri/${id}/${name}`,
});

test("messageWithForwardedContent labels forwarded text with its original author and channel", () => {
  const result = messageWithForwardedContent({
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

test("messageWithForwardedContent carries files attached to a forwarded message", () => {
  const result = messageWithForwardedContent({
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

test("messageWithForwardedContent recursively includes a nested forward", () => {
  const result = messageWithForwardedContent({
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

test("messageWithForwardedContent ignores timestamped legacy attachments", () => {
  const result = messageWithForwardedContent({
    text: "top-level message",
    attachments: [{ ts: "1787162400", author_name: "build bot", text: "legacy attachment" }],
  });

  assert.deepEqual(result, { text: "top-level message", files: [] });
});

test("messageWithForwardedContent reads legacy attachment content from bots that post an empty text", () => {
  const result = messageWithForwardedContent({
    text: "",
    attachments: [
      {
        fallback: "[acme/api] Pull request opened: #42 Fix login",
        pretext: "Pull request opened by octocat",
        title: "#42 Fix login",
        title_link: "https://github.com/acme/api/pull/42",
        text: "Handles expired sessions.",
        fields: [
          { title: "Reviewers", value: "ada" },
          { title: "Empty", value: "" },
        ],
        footer: "acme/api",
      } as never,
    ],
  });
  assert.equal(
    result.text,
    [
      "Pull request opened by octocat",
      "#42 Fix login (https://github.com/acme/api/pull/42)",
      "Handles expired sessions.",
      "Reviewers: ada",
      "acme/api",
    ].join("\n"),
  );
});

test("messageWithForwardedContent falls back to the attachment summary and skips link previews", () => {
  const result = messageWithForwardedContent({
    text: "",
    attachments: [
      { fallback: "Deploy #7 succeeded in 3m" } as never,
      { from_url: "https://example.com/run/7", title: "Run 7", text: "page preview" } as never,
    ],
  });
  assert.equal(result.text, "Deploy #7 succeeded in 3m");
});

test("messageWithForwardedContent bounds legacy attachment text", () => {
  const result = messageWithForwardedContent({
    attachments: Array.from({ length: 8 }, (_, i) => ({ text: `${i}:${"x".repeat(3_000)}` }) as never),
  });
  const lines = result.text.split("\n");
  assert.equal(lines.length, 5);
  for (const line of lines) assert.ok(line.length <= 2_001);
});
