import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../src/search.ts", import.meta.url), "utf8");
const handlers = source.slice(source.indexOf("function onQueryInput("), source.indexOf("function groupHitsBySession("));
const lifecycle = source
  .slice(source.indexOf("export function openChatSearch("), source.indexOf("function ensureHost("))
  .replace("export function", "function");

const keyboard = source.slice(
  source.indexOf("function onPaletteKeydown("),
  source.indexOf("function scrollSelectedIntoView("),
);

function harness() {
  const state = { open: true, query: "", hits: [] as unknown[], loading: false, failed: false, sel: 0 };
  const requests: Array<{ signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }> =
    [];
  let asks = 0;
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
    clampSel() {},
    askQm() {
      asks++;
    },
    askRowShown: () => true,
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
      new Promise((resolve, reject) => {
        requests.push({ signal, resolve, reject });
      }),
  });
  runInContext(stripTypeScriptTypes(handlers + lifecycle + keyboard), context);
  return {
    state,
    requests,
    asks: () => asks,
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
