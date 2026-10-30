import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("speakers outside a project show the directory photo the transcript carries", async () => {
  const session = {
    ...SESSION,
    type: "channel" as const,
    createdAt: 1000,
    scopeId: "channel:C1",
    threadRef: "slack:C1:1.0",
  };
  const speakers = [
    { name: "Ada", label: "ada", speakerId: "person-a", speakerAvatarUrl: "https://example.com/a.png" },
    { name: "Bo", label: "bo", speakerId: "person-b", speakerAvatarUrl: "http://example.com/b.png" },
    { name: "Cy", label: "cy", speakerAvatarUrl: "https://example.com/c.png" },
    { name: "Di", label: "di", speakerId: "person-d" },
  ];
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    entries: speakers.map((speaker, seq) => ({
      seq,
      type: "user",
      createdAt: 1000 + seq,
      payload: { text: `Message ${seq}`, ...speaker },
    })),
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const labels = [...document.querySelectorAll(".message-stack .user-row > .speaker-label")];
    assert.equal(labels.length, speakers.length);
    assert.deepEqual(
      labels.map((label) => label.querySelector("img")?.getAttribute("src") ?? null),
      ["https://example.com/a.png", null, null, null],
    );
    assert.match(labels[3]!.textContent!, /DI\s+di/);
  } finally {
    await h.close();
  }
});
