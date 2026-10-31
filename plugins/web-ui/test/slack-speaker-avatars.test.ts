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
    entries: [
      { seq: 1, type: "user", createdAt: 1, payload: { text: "hi", name: "Eve", speakerId: "eve@example.com" } },
      { seq: 2, type: "user", createdAt: 2, payload: { text: "yo", name: "Regan", speakerId: "regan@example.com" } },
      { seq: 3, type: "user", createdAt: 3, payload: { text: "again", name: "Eve", speakerId: "eve@example.com" } },
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
