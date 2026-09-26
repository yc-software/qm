import assert from "node:assert/strict";
import test from "node:test";
import type { CoreSession } from "../src/core-bridge.ts";
import { harness } from "./deep-link-boot-fixture.ts";

function sessions(count: number): CoreSession[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `chat-${i}`,
    threadRef: `web:tester:${i}`,
    scopeId: "personal:tester",
    type: "dm",
    title: `Chat ${i}`,
    createdAt: 1_000_000 - i,
  }));
}

function button(root: Element, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `missing button: ${label}`);
  return found;
}

test("sidebar batches retain pinned, open and selected chats, full counts and archived expansion", async () => {
  const list = sessions(230);
  list[148]!.pinned = true;
  list[149]!.pinned = true;
  for (const item of list.slice(150)) item.archived = true;
  const opened = list[147]!;
  const h = await harness({
    path: `/s/${opened.id}`,
    session: opened,
    listSessions: list,
    contexts: [
      { scopeId: "personal:tester", kind: "personal", name: "Personal", sessionCount: 230, lastActivityAt: null },
    ],
  });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    const sidebar = document.querySelector("#sidebar-body")!;
    assert.equal(sidebar.querySelectorAll(".session-row").length, 53);
    assert.equal(sidebar.querySelector(".recent-project-count")?.textContent, "148");
    for (const id of [opened.id, "chat-148", "chat-149"]) assert.ok(sidebar.querySelector(`[data-session-id="${id}"]`));
    const projectToggle = sidebar.querySelector<HTMLButtonElement>(".recent-project-toggle")!;
    projectToggle.click();
    assert.equal(sidebar.querySelectorAll(".recent-project-children .session-row").length, 0);
    projectToggle.click();
    button(sidebar, "Show more conversations").click();
    assert.equal(sidebar.querySelectorAll(".session-row").length, 103);
    for (const [id, shift] of [
      ["chat-90", false],
      ["chat-92", true],
    ] as const)
      sidebar.querySelector(`[data-session-id="${id}"] .session`)!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: " ",
          ctrlKey: !shift,
          shiftKey: shift,
          bubbles: true,
          cancelable: true,
        }),
      );
    const selected = () =>
      [...sidebar.querySelectorAll<HTMLElement>(".session-row.selected")].map((row) => row.dataset.sessionId);
    assert.deepEqual(selected(), ["chat-90", "chat-91", "chat-92"]);
    h.sessionsState.list = [
      ...sessions(120).map((item) => ({
        ...item,
        id: `new-${item.id}`,
        threadRef: `new-${item.threadRef}`,
        createdAt: item.createdAt + 10_000,
      })),
      ...list,
    ];
    h.renderList();
    assert.deepEqual(
      selected(),
      ["chat-90", "chat-91", "chat-92"],
      "newer rows must not discard the current selection",
    );
    assert.equal(sidebar.querySelector(".archived-count")?.textContent, "80");
    sidebar.querySelector<HTMLButtonElement>(".archived-count")!.closest("button")!.click();
    assert.equal(sidebar.querySelectorAll(".archived-children .session-row").length, 50);
    button(sidebar, "Show more archived conversations").click();
    assert.equal(sidebar.querySelectorAll(".archived-children .session-row").length, 80);
    sidebar.querySelector<HTMLButtonElement>(".archived-count")!.closest("button")!.click();
    assert.equal(sidebar.querySelectorAll(".archived-children .session-row").length, 0);
  } finally {
    await h.close();
  }
});

test("chat browsing batches rows while search still covers the complete history", async () => {
  const list = sessions(125);
  list[124]!.title = "Older matching conversation";
  const h = await harness({ path: "/settings", listSessions: list });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    h.appState.currentView = "chats";
    h.drawChatsPage();
    const main = document.querySelector("#main")!;
    assert.equal(main.querySelectorAll(".chat-row").length, 50);
    button(main, "Show more conversations").click();
    assert.equal(main.querySelectorAll(".chat-row").length, 100);
    const input = main.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "Older matching";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(main.querySelectorAll(".chat-row").length, 1);
    assert.match(main.querySelector(".chat-row")?.textContent ?? "", /Older matching conversation/);
    input.value = "";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(main.querySelectorAll(".chat-row").length, 50);
    assert.equal(h.sessionsState.list.length, 125);
  } finally {
    await h.close();
  }
});

test("an open project menu and rename survive the last project row leaving the batch", async () => {
  const list = sessions(50);
  const scopeId = "group:web-project-target";
  list[49]!.scopeId = scopeId;
  const h = await harness({
    path: `/s/${list[0]!.id}`,
    session: list[0],
    listSessions: list,
    contexts: [
      {
        scopeId,
        kind: "group",
        name: "Target",
        sessionCount: 1,
        lastActivityAt: null,
        project: {
          id: "target",
          scopeId,
          name: "Target",
          ownerId: "tester",
          memberIds: ["tester"],
          members: [],
        },
      },
    ],
  });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    const sidebar = document.querySelector("#sidebar-body")!;
    sidebar.querySelector<HTMLButtonElement>('[aria-label="Options for Target"]')!.click();
    h.sessionsState.list = [
      { ...list[0]!, id: "newer-chat", threadRef: "web:tester:newer", createdAt: 2_000_000 },
      ...list,
    ];
    h.renderList();
    assert.ok(sidebar.querySelector('[aria-label="Target project"] [role="menu"]'));
    button(sidebar, "Rename").click();
    const input = sidebar.querySelector<HTMLInputElement>('[aria-label="Rename project"]')!;
    input.value = "Unfinished name";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    h.renderList();
    assert.equal(sidebar.querySelector('[aria-label="Rename project"]'), input);
    assert.equal(input.value, "Unfinished name");
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(sidebar.querySelector('[aria-label="Target project"]'), null);
  } finally {
    await h.close();
  }
});
