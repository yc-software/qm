import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("Slack conversations show directory Slack photos on messages and in the header", async () => {
  const session = {
    ...SESSION,
    type: "group" as const,
    createdAt: 1,
    surface: "slack",
    canContinue: false,
    channelName: "mpdm-eve--regan-1",
  };
  const photos: Record<string, string> = {
    "eve@example.com": "https://avatars.slack-edge.com/eve_72.jpg",
    "regan@example.com": "https://avatars.slack-edge.com/regan_72.png",
  };
  const lookups: string[] = [];
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    api: (path) => {
      const url = new URL(path, "http://localhost");
      if (url.pathname !== "/api/directory/resolve") return undefined;
      const id = url.searchParams.get("q")!;
      lookups.push(id);
      return Response.json({
        matches: photos[id] ? [{ principalId: id, displayName: id, type: "internal", avatarUrl: photos[id] }] : [],
      });
    },
    items: [
      item("UserMessage", { seq: 1, createdAt: 1, text: "hi", body: { name: "Eve", speakerId: "eve@example.com" } }),
      item("UserMessage", {
        seq: 2,
        createdAt: 2,
        text: "yo",
        body: { name: "Regan", speakerId: "regan@example.com" },
      }),
      item("UserMessage", { seq: 3, createdAt: 3, text: "again", body: { name: "Eve", speakerId: "eve@example.com" } }),
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    const srcs = () => [...document.querySelectorAll(".speaker-label img")].map((i) => i.getAttribute("src"));
    for (let i = 0; i < 100 && srcs().length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(srcs(), [photos["eve@example.com"], photos["regan@example.com"], photos["eve@example.com"]]);
    assert.deepEqual(
      [...document.querySelectorAll(".chat-participants img")].map((i) => i.getAttribute("src")),
      [photos["eve@example.com"], photos["regan@example.com"]],
    );
    assert.deepEqual(lookups.sort(), ["eve@example.com", "regan@example.com"], "one lookup per person");
  } finally {
    await h.close();
  }
});
