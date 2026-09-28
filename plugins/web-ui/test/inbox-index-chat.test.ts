import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture, inboxRuntime, until } from "./inbox-composer-fixture.ts";

test("inbox sidebar restores its conversation and releases it on native navigation", async () => {
  const { dom, vite, host, close } = await createInboxFixture();
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    appState.me = { user: "taylor@example.com" };
    appState.currentView = "inbox";
    const { inboxChat } = await vite.ssrLoadModule("/src/inbox-chat.ts");
    const { allConversations } = await vite.ssrLoadModule("/src/conversations.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const session = {
      id: "inbox-session",
      threadRef: "web:taylor@example.com:inbox",
      scopeId: "personal:taylor@example.com",
      surface: "web",
      title: "Inbox",
      updatedAt: 100,
    };
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      const path = String(url);
      requests.push(path);
      if (path.includes("runtime-config")) return Response.json(inboxRuntime);
      if (path.includes("/approvals")) return Response.json({ approvals: [] });
      if (path.includes("/sessions/inbox-session")) return Response.json({ session, entries: [], earlierEntries: 4 });
      if (path.endsWith("/sessions")) return Response.json({ sessions: [session] });
      if (path.includes("/runs")) return Response.json({ runs: [] });
      return Response.json({});
    };
    render(inboxChat(), host);
    await until(() => Boolean(host.querySelector("textarea")));
    const sidebar = host.querySelector("qm-inbox-chat")!;
    const conversation = allConversations().find(
      (entry: { state: { threadRef: string } }) => entry.state.threadRef === session.threadRef,
    );
    assert.ok(conversation);
    assert.equal(conversation.state.sessionId, session.id);
    assert.equal(conversation.state.earlierCount, 4);
    assert.ok(requests.some((path) => path.includes("tailTurns=25")));
    assert.equal(appState.currentView, "inbox");
    const suggestion = [...sidebar.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Summarize my inbox"),
    )!;
    suggestion.click();
    assert.equal(sidebar.querySelector<HTMLTextAreaElement>("textarea")!.value, "Summarize my inbox");
    assert.ok(suggestion.closest(".chat-bottom-dock"));
    render(inboxChat({ kind: "inbox", hasEmail: true, hasSlack: false, hasDrafts: false }), host);
    await until(() => sidebar.textContent!.includes("Summarize my recent emails"));
    assert.equal(
      allConversations().find((entry: { state: { threadRef: string } }) => entry.state.threadRef === session.threadRef),
      conversation,
    );
    render(inboxChat({ kind: "inbox", hasEmail: true, hasSlack: true, hasDrafts: true }), host);
    await until(() => sidebar.textContent!.includes("Which drafts should I review first?"));
    const text = "Summarize this inbox\nKeep it brief.";
    conversation.state.agent.state.messages = [{ role: "user", content: text, timestamp: 100 }];
    conversation.redraw();
    assert.equal(sidebar.querySelector(".inbox-chat-msg.human .inbox-chat-text")?.textContent, text);
    assert.equal(sidebar.querySelector(".user-row, .pin-toggle"), null);
    assert.ok(sidebar.querySelector('[aria-label="Copy message"]'));
    assert.ok(sidebar.querySelector(".inbox-chat-composer .composer-wrap"));
    const count = allConversations().length;
    host.replaceChildren();
    assert.equal(allConversations().length, count - 1);
    host.append(sidebar);
    await until(() => Boolean(sidebar.querySelector("textarea")) && allConversations().length === count);
    assert.equal(
      allConversations().filter(
        (entry: { state: { threadRef: string } }) => entry.state.threadRef === session.threadRef,
      ).length,
      1,
    );
    sidebar.remove();
    assert.equal(allConversations().length, count - 1);
    assert.equal(dom.window.location.pathname, "/");
  } finally {
    await close();
  }
});
