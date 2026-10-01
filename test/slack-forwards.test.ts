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
