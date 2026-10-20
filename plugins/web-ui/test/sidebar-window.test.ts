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

test("the sidebar pages chats from the server and keeps pinned, open and selected chats and archived expansion", async () => {
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
    for (const id of [opened.id, "chat-148", "chat-149"]) assert.ok(sidebar.querySelector(`[data-session-id="${id}"]`));
    const projectToggle = sidebar.querySelector<HTMLButtonElement>(".recent-project-toggle")!;
    projectToggle.click();
    assert.equal(sidebar.querySelectorAll(".recent-project-children .session-row").length, 0);
    projectToggle.click();
    button(sidebar, "Show more conversations").click();
    const loading = button(sidebar, "Show more conversations");
    assert.ok(loading.disabled && loading.getAttribute("aria-busy") === "true");
    assert.ok(loading.querySelector(".thinking-sheen"));
    await until(
      () => sidebar.querySelectorAll(".session-row").length === 103,
      () => sidebar.querySelectorAll(".session-row").length,
    );
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
      ...h.sessionsState.list,
    ];
    h.renderList();
    assert.deepEqual(
      selected(),
      ["chat-90", "chat-91", "chat-92"],
      "newer rows must not discard the current selection",
    );
    const archivedToggle = button(sidebar, "Archived");
    archivedToggle.click();
    await until(
      () => sidebar.querySelectorAll(".archived-children .session-row").length === 50,
      () => sidebar.querySelectorAll(".archived-children .session-row").length,
    );
    button(sidebar, "Show more archived conversations").click();
    await until(
      () => sidebar.querySelectorAll(".archived-children .session-row").length === 80,
      () => sidebar.querySelectorAll(".archived-children .session-row").length,
    );
    assert.equal(sidebar.querySelector(".archived-count"), null);
    button(sidebar, "Archived").click();
    assert.equal(sidebar.querySelectorAll(".archived-children .session-row").length, 0);
  } finally {
    await h.close();
  }
});

test("chat browsing pages rows from the server and searches the complete history", async () => {
  const list = sessions(125);
  list[124]!.title = "Older matching conversation";
  const h = await harness({ path: "/settings", listSessions: list });
  try {
    h.releaseSessions();
    await h.boot();
    await h.sessionsReady();
    h.appState.currentView = "chats";
    void h.renderChatsPage();
    const main = document.querySelector("#main")!;
    await until(() => main.querySelectorAll(".chat-row").length === 50);
    button(main, "Show more conversations").click();
    await until(() => main.querySelectorAll(".chat-row").length === 100);
    const input = main.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "Older matching";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => main.querySelectorAll(".chat-row").length === 1);
    assert.match(main.querySelector(".chat-row")?.textContent ?? "", /Older matching conversation/);
    input.value = "";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await until(() => main.querySelectorAll(".chat-row").length === 50);
  } finally {
    await h.close();
  }
});

async function until(check: () => boolean, describe: () => unknown = () => ""): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), `condition never held ${String(describe())}`);
}
