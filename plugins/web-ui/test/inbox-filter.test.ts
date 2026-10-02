import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { VirtualConsole } from "jsdom";
import { createInboxFixture, until } from "./inbox-composer-fixture.ts";

const filterNames: Record<string, string> = {
  all: "All emails",
  human: "Light filtering — exclude notifications",
  triaged: "Heavy filtering — only emails that need your attention",
};

async function inboxUi(t: TestContext) {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const { dom, vite, host, close } = await createInboxFixture({
    dom: { url: "http://localhost/web-ui/", virtualConsole },
  });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  let pane: { dispose(): void } | undefined;
  let reset = () => {};
  t.after(async () => {
    pane?.dispose();
    reset();
    await close();
    assert.deepEqual(errors, []);
  });
  await vite.ssrLoadModule("/src/shell.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me = { user: "alice", org: "test", permissions: ["inbox"] };
  const inbox = await vite.ssrLoadModule("/src/inbox.ts");
  reset = inbox.resetInboxState;
  const mount = (options = {}) => {
    pane?.dispose();
    pane = inbox.mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange() {}, ...options });
  };
  return { dom, vite, host, mount, inbox };
}

test("inbox filters persist, preserve Sent, and keep refreshes consistent", async (t) => {
  const {
    dom,
    host,
    mount,
    inbox: { inboxState, resetInboxState, refreshInbox, itemsFor, toInboxItem },
  } = await inboxUi(t);
  assert.equal(inboxState.filter, "human");
  let saved = "triaged";
  let failSave = false;
  let rejectSave = false;
  let race: "preference" | "mismatch" | undefined;
  let requests: URL[] = [];
  const writes: unknown[] = [];
  const entries = [
    { id: "question", state: "held", sourcePayload: { title: "Please review the launch plan" } },
    { id: "resolved", state: "held", sourcePayload: { title: "Thanks, all set", probablyResolved: true } },
    { id: "automated", state: "pending", sourcePayload: { title: "Your receipt", automated: true } },
    { id: "pending", state: "pending", sourcePayload: { title: "Quick question" } },
  ].map((item) => ({ loopId: "email", source: "gmail", thread: [], ...item }));
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/api/ui-state")) {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.key, "inbox-filter");
      if (failSave) return Response.json({ message: "Offline" }, { status: 503 });
      if (rejectSave) return Response.json({ ok: false, updatedAt: Date.now() + 1000 });
      writes.push(body.value);
      saved = body.value;
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/api/inbox")) {
      requests.push(url);
      const filter = race === "mismatch" ? saved : (url.searchParams.get("filter") ?? saved);
      const items = entries.filter(
        (item) =>
          filter === "all" ||
          (!item.sourcePayload.automated &&
            (filter === "human" || (item.state === "held" && !item.sourcePayload.probablyResolved))),
      );
      if (race && requests.length === 1) saved = "human";
      const more = race && !url.searchParams.has("cursor") && !url.searchParams.has("view");
      let pageItems = items;
      if (url.searchParams.has("view")) pageItems = [];
      else if (more) pageItems = items.slice(0, 2);
      else if (race) pageItems = items.slice(2);
      return Response.json({
        filter,
        selected: [{ id: "email", name: "Email", count: entries.length }],
        available: [],
        items: pageItems,
        total: race === "mismatch" ? 999 : entries.length,
        nextCursor: more ? "page-2" : null,
      });
    }
    return Response.json({});
  };
  mount();
  const settled = () => until(() => !inboxState.loading && !inboxState.filterBusy);
  const filterSelect = () => host.querySelector<HTMLButtonElement>('button[aria-label="Email filter"]')!;
  const filterMenu = () => host.querySelector<HTMLElement>(".inbox-email-filter-control .menu-popover")!;
  const selectedFilter = () => {
    const label = host.querySelector('.inbox-email-filter-control [aria-checked="true"]')!.textContent!.trim();
    return Object.keys(filterNames).find((value) => filterNames[value] === label);
  };
  const chooseFilter = (value: string) => {
    filterSelect().click();
    assert.equal(filterMenu().hidden, false);
    [...filterMenu().querySelectorAll<HTMLButtonElement>(".menu-option")]
      .find((option) => option.textContent!.trim() === filterNames[value])!
      .click();
    assert.equal(filterMenu().hidden, true);
  };
  const titles = () => [...host.querySelectorAll(".inbox-item-sub")].map((item) => item.textContent?.trim());
  const assertTabCounts = () => {
    assert.deepEqual(
      [...host.querySelectorAll(".inbox-chip-count")].map((badge) => badge.textContent?.trim()),
      ["4", "4"],
    );
  };
  await settled();
  assertTabCounts();
  assert.deepEqual(
    [...host.querySelectorAll(".inbox-email-filter-control .menu-option-label")].map((element) =>
      element.textContent?.trim(),
    ),
    ["All emails", "Light filtering — exclude notifications", "Heavy filtering — only emails that need your attention"],
  );
  assert.equal(selectedFilter(), "triaged");
  assert.equal(filterSelect().getAttribute("aria-description"), "Emails identified as needing a reply or review");
  filterSelect().focus();
  filterSelect().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(filterSelect().getAttribute("aria-expanded"), "true");
  assert.equal(filterMenu().hidden, false);
  assert.equal(document.activeElement, filterMenu().querySelector("button"));
  document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(filterMenu().hidden, true);
  assert.equal(filterSelect().getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, filterSelect());
  assert.deepEqual(titles(), ["Please review the launch plan"]);
  const fetchInbox = globalThis.fetch;
  let resumeRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    resumeRefresh = resolve;
  });
  globalThis.fetch = async (input, options) => {
    await refreshGate;
    return fetchInbox(input, options);
  };
  const backgroundRefresh = refreshInbox({ silent: true });
  assert.equal(filterSelect().disabled, true);
  filterSelect().click();
  filterSelect().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(filterMenu().hidden, true);
  assert.ok([...filterMenu().querySelectorAll<HTMLButtonElement>("button")].every((option) => option.disabled));
  resumeRefresh();
  await backgroundRefresh;
  globalThis.fetch = fetchInbox;
  assert.equal(filterSelect().disabled, false);
  chooseFilter("human");
  await settled();
  assertTabCounts();
  assert.deepEqual(titles(), ["Please review the launch plan", "Thanks, all set", "Quick question"]);
  chooseFilter("all");
  await settled();
  assertTabCounts();
  assert.equal(titles().length, 4);
  assert.equal(selectedFilter(), "all");
  assert.deepEqual(writes, ["human", "all"]);
  resetInboxState();
  assert.equal(inboxState.filter, "human");
  await refreshInbox();
  assert.equal(selectedFilter(), "all");
  assert.equal(titles().length, 4);
  race = "preference";
  requests = [];
  await refreshInbox();
  assert.equal(saved, "human");
  assert.equal(inboxState.filter, "all");
  assert.equal(inboxState.total, 4);
  assert.equal(titles().length, 4);
  assert.ok(requests.some((url) => url.searchParams.has("cursor")));
  assert.ok(requests.some((url) => url.searchParams.has("view")));
  assert.equal(requests[0]!.searchParams.get("filter"), null);
  assert.ok(requests.slice(1).every((url) => url.searchParams.get("filter") === "all"));
  const previousItems = inboxState.items;
  const previousSelected = inboxState.selected;
  race = "mismatch";
  saved = "all";
  requests = [];
  await refreshInbox();
  assert.match(inboxState.error!, /Inbox filter changed/);
  assert.equal(inboxState.items, previousItems);
  assert.equal(inboxState.selected, previousSelected);
  assert.equal(inboxState.total, 4);
  assert.equal(inboxState.filter, "all");
  race = undefined;
  await refreshInbox();
  assert.equal(inboxState.filter, "human");
  assert.equal(inboxState.total, 4);
  saved = "all";
  await refreshInbox();
  failSave = true;
  chooseFilter("triaged");
  await settled();
  assert.equal(selectedFilter(), "all");
  assert.equal(inboxState.notice, "Offline");
  failSave = false;
  rejectSave = true;
  saved = "human";
  chooseFilter("triaged");
  await settled();
  assert.equal(selectedFilter(), "human");
  assert.deepEqual(titles(), ["Please review the launch plan", "Thanks, all set", "Quick question"]);
  assert.deepEqual(writes, ["human", "all"]);
  assert.equal(
    host.querySelector('[role="status"]')?.textContent,
    "A newer inbox filter was already saved. Your selection wasn't saved. Please try again.",
  );
  rejectSave = false;
  chooseFilter("triaged");
  await settled();
  assert.equal(selectedFilter(), "triaged");
  assert.deepEqual(titles(), ["Please review the launch plan"]);
  assert.deepEqual(writes, ["human", "all", "triaged"]);
  inboxState.items.push(
    toInboxItem({ ...entries[0], id: "sent", state: "actioned", sourcePayload: { automated: true } }),
  );
  for (const filter of ["all", "human", "triaged"]) {
    inboxState.filter = filter;
    assert.deepEqual(
      itemsFor("sent", "open").map((item: { id: string }) => item.id),
      ["sent"],
    );
  }
  resetInboxState();
});

test("email filters appear only on email views and leave other sources unchanged", async (t) => {
  const {
    host,
    mount,
    inbox: { inboxState, itemsFor, toInboxItem },
  } = await inboxUi(t);
  inboxState.loaded = true;
  inboxState.fetchedAt = Date.now();
  inboxState.selected = [
    { id: "email", name: "Email", sources: ["gmail"], count: 3 },
    { id: "chat", name: "Slack", source: "slack", count: 4 },
    { id: "custom", name: "Custom", sources: ["generic"], count: 1 },
    { id: "empty-email", name: "Empty email", source: "gmail", count: 0 },
    { id: "mixed", name: "Mixed", sources: ["gmail", "slack"], count: 0 },
  ];
  inboxState.items = [
    { id: "email-ready", loopId: "email", source: "gmail", state: "held", sourcePayload: {} },
    {
      id: "email-resolved",
      loopId: "email",
      source: "gmail",
      state: "held",
      sourcePayload: { probablyResolved: true },
    },
    { id: "email-automated", loopId: "email", source: "gmail", state: "pending", sourcePayload: { automated: true } },
    { id: "slack-ready", loopId: "chat", source: "slack", state: "held", sourcePayload: {} },
    { id: "slack-bot", loopId: "chat", source: "slack", state: "held", sourcePayload: { automated: true } },
    { id: "slack-resolved", loopId: "chat", source: "slack", state: "held", sourcePayload: { probablyResolved: true } },
    { id: "slack-pending", loopId: "chat", source: "slack", state: "pending", sourcePayload: {} },
    { id: "generic-pending", loopId: "custom", source: "generic", state: "pending", sourcePayload: {} },
  ].map(toInboxItem);
  const ids = (view: string) => itemsFor(view, "open").map((item: { id: string }) => item.id);
  for (const [filter, emails] of [
    ["triaged", ["email-ready"]],
    ["human", ["email-ready", "email-resolved"]],
    ["all", ["email-ready", "email-resolved", "email-automated"]],
  ] as const) {
    inboxState.filter = filter;
    assert.deepEqual(ids("all"), [...emails, "slack-ready", "slack-bot", "slack-resolved"]);
    assert.deepEqual(ids("email"), emails);
    assert.deepEqual(ids("chat"), ["slack-ready", "slack-bot", "slack-resolved"]);
    assert.deepEqual(ids("custom"), []);
    for (const viewId of ["all", "gmail", "email", "empty-email", "mixed"]) {
      mount({ viewId });
      assert.equal(host.querySelector(".inbox-filter > span")?.textContent, "Emails");
      assert.equal(
        host.querySelector('.inbox-email-filter-control [aria-checked="true"]')?.textContent?.trim(),
        filterNames[filter],
      );
    }
    for (const viewId of ["slack", "chat", "custom", "sent"]) {
      mount({ viewId });
      assert.equal(host.querySelector(".inbox-filter"), null);
      if (viewId === "slack" || viewId === "chat") {
        assert.equal(host.querySelectorAll(".inbox-resolved-list .inbox-item").length, 1);
        assert.match(host.querySelector(".inbox-resolved-head")!.textContent!, /Probably resolved/);
        assert.equal(host.querySelectorAll(".inbox-list:not(.inbox-resolved-list) .inbox-item").length, 2);
      }
      assert.doesNotMatch(host.querySelector(".inbox-zero")?.textContent ?? "", /Choose Light filtering/);
    }
  }
});

test("email filters default to Light filtering when the feed omits a preference", async (t) => {
  const {
    host,
    mount,
    inbox: { inboxState, refreshInbox },
  } = await inboxUi(t);
  const items = [
    { id: "pending", state: "pending", sourcePayload: { title: "Quick question" } },
    { id: "resolved", state: "held", sourcePayload: { title: "Thanks, all set", probablyResolved: true } },
    { id: "automated", state: "pending", sourcePayload: { title: "Your receipt", automated: true } },
  ].map((item) => ({ loopId: "email", source: "gmail", thread: [], ...item }));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.endsWith("/api/inbox")) return Response.json({});
    return Response.json({
      selected: [{ id: "email", name: "Email", sources: ["gmail"], count: items.length }],
      available: [],
      items: url.searchParams.has("view") ? [] : items,
      total: items.length,
      nextCursor: null,
    });
  };
  inboxState.filter = "triaged";
  await refreshInbox();
  mount();
  assert.equal(inboxState.filter, "human");
  assert.equal(
    host.querySelector('.inbox-email-filter-control [aria-checked="true"]')?.textContent?.trim(),
    filterNames.human,
  );
  assert.deepEqual(
    [...host.querySelectorAll(".inbox-item-sub")].map((item) => item.textContent?.trim()),
    ["Quick question", "Thanks, all set"],
  );
});

test("the inbox filter is unavailable without Inbox access", async (t) => {
  const { host, mount, vite, inbox } = await inboxUi(t);
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me.permissions = [];
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({});
  };
  mount();
  await inbox.refreshInbox();
  assert.equal(host.querySelector(".inbox-email-filter-control"), null);
  assert.deepEqual(requests, []);
});
