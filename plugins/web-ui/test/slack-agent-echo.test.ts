import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToMessages, type SessionEntry } from "../src/core-bridge.ts";

const reply = "gpt-image-1.5, through the image-edit tool, and yes, it grew him a third arm.";

test("the agent's own Slack messages replayed as overheard entries are not shown as user bubbles", () => {
  const entries: SessionEntry[] = [
    { type: "user", seq: 1, createdAt: 1, payload: { text: "what model was used?", name: "regan" } },
    { type: "assistant", seq: 2, createdAt: 2, payload: { text: reply } },
    {
      type: "user",
      seq: 3,
      createdAt: 3,
      payload: { overheard: true, sourceRole: "agent", ts: "1793118895.507329", text: reply, name: "regan" },
    },
    {
      type: "user",
      seq: 4,
      createdAt: 4,
      payload: { overheard: true, sourceRole: "agent", ts: "1793119102.860789", text: "", files: ["qm-dance.gif"] },
    },
    { type: "user", seq: 5, createdAt: 5, payload: { text: "can you expand to show the whole guy?", name: "regan" } },
    { type: "assistant", seq: 6, createdAt: 6, payload: { text: "Outpainting him downward." } },
  ];
  const messages = entriesToMessages(entries);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  const userTexts = messages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content);
  assert.deepEqual(userTexts, ["what model was used?", "can you expand to show the whole guy?"]);
});

test("other people's overheard Slack messages still render as user messages with their name", () => {
  const messages = entriesToMessages([
    { type: "user", seq: 1, createdAt: 1, payload: { overheard: true, ts: "1.0", text: "hello all", name: "sam" } },
    { type: "user", seq: 2, createdAt: 2, payload: { text: "@qm summarize", name: "regan" } },
    { type: "assistant", seq: 3, createdAt: 3, payload: { text: "Sam said hello." } },
  ]);
  assert.deepEqual(
    messages.map((m) => [m.role, (m as { speaker?: string }).speaker]),
    [
      ["user", "sam"],
      ["user", "regan"],
      ["assistant", undefined],
    ],
  );
});

test("a Slack conversation draws the agent's echoed reply once, as an assistant message", async () => {
  const { harness, SESSION } = await import("./deep-link-boot-fixture.ts");
  const h = await harness({
    path: "/s/sess-deep",
    session: { ...SESSION, type: "dm", createdAt: 1, surface: "slack", canContinue: false },
    entries: [
      { seq: 1, type: "user", createdAt: 1, payload: { text: "what model was used?", name: "regan" } },
      { seq: 2, type: "assistant", createdAt: 2, payload: { text: reply } },
      {
        seq: 3,
        type: "user",
        createdAt: 3,
        payload: { overheard: true, sourceRole: "agent", ts: "1793118895.507329", text: reply, name: "regan" },
      },
      { seq: 4, type: "user", createdAt: 4, payload: { text: "can you expand?", name: "regan" } },
    ],
  });
  try {
    await h.boot();
    let rows: Element[] = [];
    for (let i = 0; i < 100 && rows.length < 2; i++) {
      rows = [...document.querySelectorAll(".message-row.user-row .slack-wire-text")];
      if (rows.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      rows.map((row) => row.textContent?.trim()),
      ["what model was used?", "can you expand?"],
    );
    assert.equal(document.body.textContent?.split(reply).length, 2);
  } finally {
    await h.close();
  }
});
