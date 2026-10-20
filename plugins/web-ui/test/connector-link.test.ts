import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorLinksOf, takeLinks } from "../src/connector-link.ts";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";

const URL = "https://agent.example.com/connect/redeem/abc123?p=google&returnTo=%2Fchats";
const COMPOSIO_URL = "https://connect.composio.dev/link/lk_example123";

test("a minted link is removed from the reply whether bare, bracketed, linked or emphasized", () => {
  for (const shown of [URL, `<${URL}>`, `**${URL}**`, `*${URL}*`, `__${URL}__`, `**[Connect Google](${URL})**`]) {
    assert.equal(
      takeLinks(`Tap this: ${shown}\n\nit expires soon.`, [URL]).body,
      "Tap this:\n\nit expires soon.",
      shown,
    );
  }
});

test("the reply's own label for a minted link is kept for its card", () => {
  const { body, labels } = takeLinks(`- [Authorize Gmail](${COMPOSIO_URL})\n- and ${URL}`, [COMPOSIO_URL, URL]);
  assert.equal(body, "-\n- and");
  assert.deepEqual(
    [...labels],
    [
      [COMPOSIO_URL, "Authorize Gmail"],
      [URL, ""],
    ],
  );
});

test("links that were not minted, and minted links inside code, stay in the reply", () => {
  const text = `Sign in at https://managed-auth.onkernel.com/login/abc and run \`curl ${COMPOSIO_URL}\``;
  const { body, labels } = takeLinks(text, [URL, COMPOSIO_URL]);
  assert.equal(labels.size, 0);
  assert.equal(body, text);
});

test("only well-formed typed links are read from a reply", () => {
  assert.deepEqual(
    connectorLinksOf({
      connectorLinks: [
        { provider: "composio", url: COMPOSIO_URL, toolkit: "gmail", logoUrl: "https://logos.composio.dev/api/gmail" },
        { provider: "google", url: URL, toolkit: "" },
        { provider: "", url: URL },
        { provider: "x" },
        null,
      ],
    }),
    [
      { provider: "composio", url: COMPOSIO_URL, toolkit: "gmail", logoUrl: "https://logos.composio.dev/api/gmail" },
      { provider: "google", url: URL },
    ],
  );
  assert.deepEqual(connectorLinksOf({ text: URL }), []);
});

test("a reply's typed links reach the message that renders it", () => {
  const link = { provider: "google", url: URL };
  const entries: SessionEntry[] = [
    { type: "user", seq: 1, createdAt: 100, payload: { text: "connect google" } },
    { type: "text", seq: 2, createdAt: 105, payload: { text: "Minting a link." } },
    { type: "assistant", seq: 3, createdAt: 110, payload: { text: `Tap ${URL}`, connectorLinks: [link] } },
    { type: "assistant", seq: 4, createdAt: 111, payload: { text: "", connectorLinks: [link] } },
    { type: "user", seq: 5, createdAt: 120, payload: { text: "thanks" } },
    { type: "assistant", seq: 6, createdAt: 130, payload: { text: "Done." } },
  ];
  const replies = entriesToMessages(entries).filter((m) => m.role === "assistant") as AssistantWork[];
  assert.deepEqual(
    replies.map((m) => m.connectorLinks),
    [[link], undefined],
  );
});
