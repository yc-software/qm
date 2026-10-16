import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("project speaker photos follow authenticated identity, not duplicate or reassigned names", async () => {
  const session = {
    ...SESSION,
    type: "group" as const,
    createdAt: 1000,
    scopeId: "group:project",
    threadRef: "web:project:chat",
  };
  const speakers = [
    { name: "Alex", label: "alex", speakerId: "person-a" },
    { name: "Alex", label: "alex", speakerId: "person-b" },
    { name: "Old Name", label: "old", speakerId: "person-c" },
    { name: "Alex", label: "alex" },
    { name: "Old Name", label: "old" },
    { name: "Departed", label: "departed", speakerId: "missing-person" },
    { name: "  ÉLODIE\tMoreau  ", label: "élodie" },
    { name: "Mary-Jane Watson", label: "mary-jane" },
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
    entries: [
      ...speakers.map((speaker, seq) => ({
        seq,
        type: "user",
        createdAt: 1000 + seq,
        payload: { text: `Message ${seq}`, ...speaker },
      })),
      { seq: speakers.length, type: "assistant", createdAt: 2000, payload: { text: "Here is the plan." } },
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    const labels = [...document.querySelectorAll(".message-stack .user-row > .speaker-label")];
    assert.equal(labels.length, speakers.length);
    for (const [index, label] of labels.entries()) {
      const row = label.closest(".named-user-row")!;
      assert.ok(row);
      assert.equal(label.parentElement, row);
      assert.equal(label.querySelector(":scope > span:not(.inbox-avatar)")?.textContent, speakers[index]!.label);
      assert.equal(label.querySelector(":scope > span[title]")?.getAttribute("title"), speakers[index]!.name.trim());
      assert.equal(
        row.querySelector<HTMLElement & { content: string }>(":scope > .user-bubble > .pin-content > qm-markdown")
          ?.content,
        `Message ${index}`,
      );
      assert.ok(row.querySelector(":scope > .user-bubble > .pin-toggle"));
      assert.ok(row.querySelector(":scope > .message-meta"));
    }
    assert.deepEqual(
      labels.map((label) => label.querySelector("img")?.getAttribute("src") ?? null),
      [
        "https://example.com/a.png",
        "https://example.com/b.png",
        "https://example.com/c.png",
        null,
        null,
        null,
        null,
        null,
      ],
    );
    assert.match(labels[2]!.textContent!, /old/);
    assert.match(labels[3]!.textContent!, /AL\s+alex/);
    assert.match(labels[4]!.textContent!, /ON\s+old/);
    const assistantLabel = () => document.querySelector(".named-assistant-row > .speaker-label");
    assert.equal(assistantLabel()?.textContent?.trim(), "QM");
    assert.ok(assistantLabel()?.querySelector(".brand-mark"));
    const conversation = h.visibleConversation();
    const brand = document.createElement("meta");
    brand.name = "brand-self-label";
    brand.content = "Harbor";
    document.head.append(brand);
    conversation.drawActiveChat();
    assert.equal(assistantLabel()?.textContent?.trim(), "Harbor");
    brand.remove();
    for (const message of conversation.state.agent!.state.messages) {
      (message as { speaker?: string }).speaker = undefined;
    }
    conversation.drawActiveChat();
    assert.equal(document.querySelector(".named-user-row"), null);
    assert.equal(document.querySelector(".speaker-label"), null);
    assert.equal(document.querySelector(".named-assistant-row"), null);
    assert.equal(
      document.querySelector<HTMLElement & { content: string }>(".user-row > .user-bubble > .pin-content > qm-markdown")
        ?.content,
      "Message 0",
    );
    (conversation.state.agent!.state.messages[0] as { speaker?: string }).speaker = "Alex";
    (conversation.state.agent!.state.messages[1] as { speaker?: string }).speaker = "Blair";
    conversation.drawActiveChat();
    assert.equal(assistantLabel()?.textContent?.trim(), "QM");
  } finally {
    await h.close();
  }
});
