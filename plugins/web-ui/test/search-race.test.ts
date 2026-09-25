import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
const handlers = source.slice(source.indexOf("function onQueryInput("), source.indexOf("function groupHitsBySession("));
const selection = source.slice(source.indexOf("function rowCount("), source.indexOf("function onQueryInput("));
const lifecycle = source
  .slice(source.indexOf("export function openChatSearch("), source.indexOf("function ensureHost("))
  .replace("export function", "function");

const keyboard = source.slice(
  source.indexOf("function onPaletteKeydown("),
  source.indexOf("function scrollSelectedIntoView("),
);

function harness() {
  const state = {
    open: true,
    query: "",
    hits: [] as unknown[],
    resources: [] as unknown[],
    loading: false,
    failed: false,
    sel: 0,
    selectionMoved: false,
  };
  const requests: Array<{ signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }> =
    [];
  const resourceRequests: typeof requests = [];
  let asks = 0;
  const opened: unknown[] = [];
  let timer: (() => void) | undefined;
  const context = createContext({
    searchState: state,
    MIN_QUERY_LEN: 2,
    DEBOUNCE_MS: 150,
    debounceTimer: null,
    inflight: null,
    fetchSeq: 0,
    AbortController,
    draw() {},
    resourceResults: (r: unknown) => r,
    UI_BASE: "",
    resourceHits: () => state.resources,
    openResource: (hit: unknown) => opened.push(hit),
    openHit: (hit: unknown) => opened.push(hit),
    scrollSelectedIntoView() {},
    askQm() {
      asks++;
    },
    requestAnimationFrame() {},
    groupHitsBySession: (hits: unknown[]) => hits,
    clearTimeout() {
      timer = undefined;
    },
    setTimeout(fn: () => void) {
      timer = fn;
      return 1;
    },
    api: (_path: string, { signal }: { signal: AbortSignal }) =>
      _path.startsWith("/api/resources/")
        ? new Promise((resolve, reject) => {
            resourceRequests.push({ signal, resolve, reject });
          })
        : new Promise((resolve, reject) => {
            requests.push({ signal, resolve, reject });
          }),
  });
  runInContext(stripTypeScriptTypes(selection + handlers + lifecycle + keyboard), context);
  return {
    state,
    requests,
    resourceRequests,
    asks: () => asks,
    opened,
    resources(hits: unknown[]) {
      state.resources = hits;
    },
    down() {
      runInContext("onPaletteKeydown({key: 'ArrowDown', preventDefault(){}})", context);
    },
    enter() {
      runInContext("onPaletteKeydown({key: 'Enter', preventDefault(){}})", context);
    },
    input(value: string) {
      context.inputValue = value;
      runInContext("onQueryInput({currentTarget:{value:inputValue}})", context);
    },
    fire() {
      const fn = timer;
      timer = undefined;
      fn?.();
    },
    close() {
      runInContext("closeChatSearch()", context);
    },
    open() {
      runInContext("openChatSearch()", context);
    },
  };
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`typing invalidates an old ${outcome} before the next debounce fires`, async () => {
    const h = harness();
    h.input("old");
    h.fire();
    h.input("document");
    assert.equal(h.requests[0]!.signal.aborted, true);
    if (outcome === "resolve") h.requests[0]!.resolve({ hits: [{ sessionId: "old" }] });
    else h.requests[0]!.reject(new Error("timeout"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.hits.length, 0);
    assert.equal(h.state.failed, false);
    assert.equal(h.state.loading, true);
    h.fire();
    h.requests[1]!.resolve({ hits: [{ sessionId: "document" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.state.hits, [{ sessionId: "document" }]);
    assert.equal(h.state.loading, false);
  });
}

test("new input clears selectable stale hits and previous errors", () => {
  const h = harness();
  h.state.hits = [{ sessionId: "old" }];
  h.state.failed = true;
  h.input("document");
  assert.equal(h.state.hits.length, 0);
  assert.equal(h.state.failed, false);
});

test("closing and reopening cannot accept a previous request", async () => {
  const h = harness();
  h.input("old");
  h.fire();
  h.close();
  h.open();
  h.requests[0]!.resolve({ hits: [{ sessionId: "old" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.hits.length, 0);
  assert.equal(h.state.query, "");
});

test("clearing the query cancels pending and in-flight searches", async () => {
  const h = harness();
  h.input("old");
  h.fire();
  h.input("document");
  h.input("");
  h.fire();
  assert.equal(h.requests.length, 1);
  h.requests[0]!.resolve({ hits: [{ sessionId: "old" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.hits.length, 0);
  assert.equal(h.state.loading, false);
});

test("Enter while searching does not start an unintended agent conversation", () => {
  const h = harness();
  h.input("document");
  h.enter();
  assert.equal(h.asks(), 0);
});

test("Enter opens resources before chats and offsets chat selection correctly", () => {
  const h = harness();
  h.input("skill");
  const resource = { title: "Skill", href: "/skills/1" };
  const chat = { sessionId: "chat1" };
  h.resources([resource]);
  h.state.hits = [chat];
  h.state.loading = true;
  h.enter();
  assert.deepEqual(h.opened, [resource]);
  h.state.loading = false;
  h.state.sel = 1;
  h.enter();
  assert.deepEqual(h.opened, [resource, chat]);
  h.state.sel = 2;
  Object.assign(h.state, { resourcesLoading: false });
  h.enter();
  assert.equal(h.asks(), 1);
});

test("chat results do not wait for resource results, and stale resource replies are ignored", async () => {
  const h = harness();
  h.input("old");
  h.fire();
  h.requests[0]!.resolve({ hits: [{ sessionId: "old" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.loading, false);
  assert.equal(h.state.hits.length, 1);
  h.input("new");
  h.fire();
  h.resourceRequests[0]!.resolve({ hits: [{ title: "Old" }], failed: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify((h.state as unknown as { resources: unknown[] }).resources), "[]");
  h.resourceRequests[1]!.resolve({ hits: [{ title: "New" }], failed: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify((h.state as unknown as { resources: unknown[] }).resources), '[{"title":"New"}]');
  assert.equal(h.state.loading, true);
});

test("closing search aborts both requests and prevents old resources reappearing after reopen", async () => {
  const h = harness();
  h.input("old");
  h.fire();
  h.close();
  h.open();
  assert.equal(h.resourceRequests[0]!.signal.aborted, true);
  h.resourceRequests[0]!.resolve({ hits: [{ title: "Old" }], failed: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify((h.state as unknown as { resources: unknown[] }).resources), "[]");
});

for (const navigate of [false, true]) {
  test(`late resources preserve the ${navigate ? "keyboard-selected" : "first"} chat`, async () => {
    const h = harness();
    h.input("document");
    h.fire();
    const chats = [{ sessionId: "first" }, { sessionId: "second" }];
    h.requests[0]!.resolve({ hits: chats });
    await new Promise((resolve) => setImmediate(resolve));
    if (navigate) h.down();
    h.resourceRequests[0]!.resolve({ hits: [{ title: "One" }, { title: "Two" }], failed: [] });
    await new Promise((resolve) => setImmediate(resolve));
    h.enter();
    assert.deepEqual(h.opened, [chats[navigate ? 1 : 0]]);
  });
}

for (const first of ["chats", "resources"] as const) {
  test(`late ${first === "chats" ? "resources" : "chats"} preserve the explicitly selected ask row`, async () => {
    const h = harness();
    h.input("document");
    h.fire();
    const chats = { hits: [{ sessionId: "chat" }] };
    const resources = { hits: [{ title: "Resource" }], failed: [] };
    if (first === "chats") h.requests[0]!.resolve(chats);
    else h.resourceRequests[0]!.resolve(resources);
    await new Promise((resolve) => setImmediate(resolve));
    h.down();
    if (first === "chats") h.resourceRequests[0]!.resolve(resources);
    else h.requests[0]!.resolve(chats);
    await new Promise((resolve) => setImmediate(resolve));
    h.enter();
    assert.equal(h.asks(), 1);
    assert.deepEqual(h.opened, []);
  });
}

test("initial resources select the first result instead of retaining the default ask row", async () => {
  const h = harness();
  h.input("document");
  h.fire();
  const resource = { title: "Resource" };
  h.resourceRequests[0]!.resolve({ hits: [resource], failed: [] });
  await new Promise((resolve) => setImmediate(resolve));
  h.enter();
  assert.deepEqual(h.opened, [resource]);
});
