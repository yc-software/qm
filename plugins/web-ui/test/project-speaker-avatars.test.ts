import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("project speaker photos follow authenticated identity, not duplicate or reassigned names", async () => {
  const session = { ...SESSION, scopeId: "group:project", threadRef: "web:project:chat" };
  const speakers = [
    { name: "Alex", speakerId: "person-a" },
    { name: "Alex", speakerId: "person-b" },
    { name: "Old Name", speakerId: "person-c" },
    { name: "Alex" },
    { name: "Old Name" },
    { name: "Departed", speakerId: "missing-person" },
  ];
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    contexts: [
      {
        scopeId: session.scopeId,
        kind: "group",
        name: "Project",
        sessionCount: 1,
        lastActivityAt: 1000,
        project: {
          id: "project",
          name: "Project",
          ownerId: "person-a",
          memberIds: ["person-a", "person-b", "person-c", "person-d", "person-e"],
          scopeId: session.scopeId,
          members: [
            { principalId: "person-a", displayName: "Alex", avatarUrl: "https://example.com/a.png" },
            { principalId: "person-b", displayName: "Alex", avatarUrl: "https://example.com/b.png" },
            { principalId: "person-c", displayName: "New Name", avatarUrl: "https://example.com/c.png" },
            { principalId: "person-d", displayName: "Old Name", avatarUrl: "https://example.com/d.png" },
            { principalId: "person-e", displayName: "Departed", avatarUrl: "https://example.com/e.png" },
          ],
        },
      },
    ],
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
    const labels = [...document.querySelectorAll(".message-stack .speaker-label")];
    assert.equal(labels.length, speakers.length);
    assert.deepEqual(
      labels.map((label) => label.querySelector("img")?.getAttribute("src") ?? null),
      ["https://example.com/a.png", "https://example.com/b.png", "https://example.com/c.png", null, null, null],
    );
    assert.match(labels[2]!.textContent!, /Old Name/);
    assert.match(labels[3]!.textContent!, /AL\s+Alex/);
    assert.match(labels[4]!.textContent!, /ON\s+Old Name/);
  } finally {
    await h.close();
  }
});
