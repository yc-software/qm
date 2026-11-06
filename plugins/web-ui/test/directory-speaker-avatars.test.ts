import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("speakers outside a project show their directory photo", async () => {
  const session = {
    ...SESSION,
    type: "channel" as const,
    createdAt: 1000,
    scopeId: "channel:C1",
    threadRef: "slack:C1:1.0",
  };
  const photos: Record<string, string> = { "ada@example.com": "https://avatars.example.com/ada.png" };
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    api: (path) => {
      const url = new URL(path, "http://localhost");
      if (url.pathname !== "/api/directory/resolve") return undefined;
      const id = url.searchParams.get("q")!;
      return Response.json({
        matches: photos[id] ? [{ principalId: id, displayName: id, type: "internal", avatarUrl: photos[id] }] : [],
      });
    },
    items: [
      item("UserMessage", { seq: 1, createdAt: 1001, text: "hi", body: { name: "Ada", speakerId: "ada@example.com" } }),
      item("UserMessage", { seq: 2, createdAt: 1002, text: "yo", body: { name: "Di", speakerId: "di@example.com" } }),
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const labels = () => [...document.querySelectorAll(".message-stack .user-row > .speaker-label")];
    const srcs = () => labels().map((label) => label.querySelector("img")?.getAttribute("src") ?? null);
    for (let i = 0; i < 100 && !srcs()[0]; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(srcs(), [photos["ada@example.com"], null]);
    assert.match(labels()[1]!.textContent!, /DI\s+di/);
  } finally {
    await h.close();
  }
});
