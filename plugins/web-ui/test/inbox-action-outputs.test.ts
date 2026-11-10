import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture, inboxRuntime, until } from "./inbox-composer-fixture.ts";

const loop = { id: "loop-1", source: "gmail", prioritize: true, consolidate: true };
const ledger = (extra: Record<string, unknown> = {}) => ({
  id: "item-1",
  loopId: "loop-1",
  state: "held",
  source: "gmail",
  sourceKey: "thread-1",
  sourcePayload: { title: "Weekly report", from: "Sam", snippet: "Numbers attached", draft: { body: "Thanks" } },
  thread: [],
  ...extra,
});
const output = (id: string, state: string) => ({
  id,
  itemId: "item-1",
  loopId: "loop-1",
  title: `Report ${id}`,
  shipAction: "send_email",
  state,
});

async function openItem(outputs: unknown[], action: (kind: string, args: Record<string, unknown>) => unknown) {
  const fixture = await createInboxFixture({ dom: { url: "http://localhost/web-ui/inbox/item-1" } });
  const { vite, dom } = fixture;
  await vite.ssrLoadModule("/src/shell.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  const inbox = await vite.ssrLoadModule("/src/inbox.ts");
  const kinds: string[] = [];
  let current: { item: unknown; outputs: unknown } = { item: ledger(), outputs };
  let gate: Promise<void> | null = null;
  let release = () => {};
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("runtime-config")) return Response.json(inboxRuntime);
    if (gate && !path.endsWith("/action")) await gate;
    if (path.includes("itemId=") || path.endsWith("/items/item-1")) return Response.json(current);
    if (path.includes("/api/inbox?")) {
      const items = path.includes("view=handled") ? [] : [current.item];
      return Response.json({ filter: "human", selected: [loop], available: [], items, total: 1, nextCursor: null });
    }
    if (path.endsWith("/action")) {
      const { kind, args } = JSON.parse(String(init?.body));
      kinds.push(kind);
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      current = action(kind, args ?? {}) as typeof current;
      return Response.json(current);
    }
    return Response.json({});
  };
  appState.me = { user: "taylor@example.com", permissions: ["inbox"] };
  appState.currentView = "inbox";
  appState.mainEl = dom.window.document.getElementById("main");
  inbox.routeInboxHistory("item-1");
  await inbox.refreshInbox();
  const main = appState.mainEl as HTMLElement;
  await until(() => Boolean(main.querySelector(".inbox-artifact, .inbox-draft")));
  const stored = () => inbox.inboxState.items.find((item: { id: string }) => item.id === "item-1");
  const settle = (check: () => boolean) => until(check);
  return { ...fixture, main, kinds, stored, settle, inbox, release: () => release() };
}

const ready = [output("old", "ready")];
const fresh = [output("new", "ready")];

test("prioritizing, archiving and reopening an item under review each take the server's outputs", async () => {
  const closed = [output("old", "superseded")];
  const reopened = [output("reopened", "ready")];
  const t = await openItem(ready, (kind) => {
    if (kind === "prioritize")
      return { item: ledger({ triage: { priority: "urgent", groupId: "item-1" } }), outputs: fresh };
    if (kind === "dismiss") return { item: ledger({ state: "dismissed" }), outputs: closed };
    return { item: ledger(), outputs: reopened };
  });
  try {
    t.inbox.inboxState.items = [
      { ...t.stored(), groupId: "item-1" },
      t.inbox.toInboxItem(ledger({ id: "item-2", triage: { groupId: "item-1" } })),
    ];
    t.inbox.drawAll();
    const select = t.main.querySelector<HTMLSelectElement>(".inbox-priority-control select")!;
    select.value = "urgent";
    select.dispatchEvent(new t.dom.window.Event("change", { bubbles: true }));
    await t.settle(() => t.stored()?.priority === "urgent");
    assert.deepEqual(t.stored().outputs, fresh);
    assert.match(t.main.querySelector(".inbox-artifact h2")?.textContent ?? "", /Report new/);
    t.release();
    await t.settle(() =>
      /Archive all 2/.test(t.main.querySelector(".inbox-item-head > .inbox-dismiss")?.textContent ?? ""),
    );
    t.main.querySelector<HTMLButtonElement>(".inbox-item-head > .inbox-dismiss")!.click();
    await t.settle(() => t.stored().status === "dismissed");
    assert.deepEqual(t.stored().outputs, closed);
    t.release();
    await t.settle(() => {
      t.main.querySelector<HTMLButtonElement>(".inbox-reopen")?.click();
      return t.kinds.includes("reopen");
    });
    await t.settle(() => t.stored().status === "open");
    assert.deepEqual(t.stored().outputs, reopened);
    assert.deepEqual(t.kinds, ["prioritize", "dismiss", "reopen"]);
    t.release();
  } finally {
    await t.close();
  }
});

test("saving a draft edit takes the outputs the server returns", async () => {
  const t = await openItem([], (_kind, args) => ({
    item: ledger({ proposal: { data: args.proposal, by: "human", at: 2 } }),
    outputs: fresh,
  }));
  try {
    const body = t.main.querySelector<HTMLTextAreaElement>(".inbox-draft textarea")!;
    body.value = "Thanks, looks good";
    body.dispatchEvent(new t.dom.window.Event("input", { bubbles: true }));
    body.dispatchEvent(new t.dom.window.Event("blur"));
    await t.settle(() => t.kinds.includes("edit") && Boolean(t.main.querySelector(".inbox-artifact")));
    assert.deepEqual(t.stored().outputs, fresh);
    t.release();
  } finally {
    await t.close();
  }
});

test("starting another reply from Sent keeps the inbox copy's outputs from the server", async () => {
  const sentChat = (state: string) =>
    ledger({
      state,
      sourcePayload: { sentChat: true, title: "Weekly report", from: "Sam", gmail: { threadId: "thread-1" } },
    });
  const t = await openItem(ready, (kind) => ({
    item: sentChat(kind === "reply" ? "held" : "actioned"),
    outputs: fresh,
  }));
  try {
    const sent = await t.vite.ssrLoadModule("/src/sent-mail.ts");
    const message = {
      id: "message-1",
      threadId: "thread-1",
      to: "Alex",
      subject: "Weekly report",
      snippet: "Sent",
      sentAt: 1,
    };
    const { appState } = await t.vite.ssrLoadModule("/src/shell-state.ts");
    const fetchInbox = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const path = String(url);
      if (path.startsWith("/api/inbox/sent/"))
        return Response.json({ ...message, from: "Sam", cc: "", body: "Sent", html: false, attachments: [] });
      if (path === "/api/inbox/sent-chat") return Response.json({ item: sentChat("actioned") });
      return fetchInbox(url, init);
    };
    t.inbox.resetActiveInboxItem();
    await sent.openSentEmail(message, t.inbox.drawAll);
    appState.currentView = "inbox";
    t.inbox.drawAll();
    const another = await t
      .settle(() => [...t.main.querySelectorAll("button")].some((b) => /Write another reply/.test(b.textContent ?? "")))
      .then(() =>
        [...t.main.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
          /Write another reply/.test(b.textContent ?? ""),
        )!,
      );
    another.click();
    await t.settle(() => t.kinds.includes("reply"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(t.stored().outputs, fresh);
    t.release();
  } finally {
    await t.close();
  }
});
