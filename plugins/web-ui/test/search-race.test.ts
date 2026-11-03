import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { browserEnv } from "./browser-env.ts";

type Pending = { signal: AbortSignal; resolve: (body: unknown) => void; reject: (error: Error) => void };
let requests: Pending[] = [];
let resourceRequests: Pending[] = [];
let opened: string[] = [];
const sessions = ["old", "document", "first", "second", "chat", "chat1"].map((id) => ({
  id,
  threadRef: `web:tester:${id}`,
  scopeId: "personal:tester",
  title: id,
}));
const runtimeConfig = {
  scopeId: "personal:tester",
  models: [],
  modelCatalog: {},
  orgDefault: { modelId: "m", revision: 1 },
  scopeOverride: null,
  effective: { modelId: "m" },
  upgradeAvailable: false,
};
const env = await browserEnv({
  fetch: (input, init) => {
    const path = String(input);
    const chats = path.startsWith("/api/search?");
    if (chats || path.startsWith("/api/resources/search?"))
      return new Promise<Response>((resolve, reject) =>
        (chats ? requests : resourceRequests).push({
          signal: init!.signal!,
          resolve: (body) => resolve(Response.json(body)),
          reject,
        }),
      );
    const id = path.match(/^\/api\/sessions\/([^/?]+)\?/)?.[1];
    if (id) opened.push(id);
    if (path.startsWith("/api/runtime-config")) return Promise.resolve(Response.json(runtimeConfig));
    if (path.endsWith("/approvals")) return Promise.resolve(Response.json({ approvals: [] }));
    if (path.startsWith("/api/sessions?")) return Promise.resolve(Response.json({ sessions }));
    if (id) return Promise.resolve(Response.json({ session: sessions.find((s) => s.id === id), items: [] }));
    return Promise.resolve(Response.json({}));
  },
});
const realLocation = env.dom.window.location;
Object.defineProperty(globalThis, "location", {
  configurable: true,
  writable: true,
  value: new Proxy(
    {},
    {
      get: (_, key) =>
        key === "assign" ? (href: string) => opened.push(href) : (Reflect.get(realLocation, key) as unknown),
    },
  ),
});
after(env.close);

let openChatSearch: () => void;

beforeEach(async () => {
  requests = [];
  resourceRequests = [];
  opened = [];
  document.body.innerHTML = '<div id="app"></div><main></main>';
  env.vite.moduleGraph.invalidateAll();
  const { appState } = await env.vite.ssrLoadModule("/src/shell.ts");
  const { sessionsState } = await env.vite.ssrLoadModule("/src/sessions.ts");
  ({ openChatSearch } = await env.vite.ssrLoadModule("/src/search.ts"));
  appState.me = { user: "tester", org: "test" };
  appState.currentView = "chats";
  appState.mainEl = document.querySelector("main");
  sessionsState.list = sessions;
  openChatSearch();
});

afterEach(() => {
  if (input()) close();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const fire = () => new Promise((resolve) => setTimeout(resolve, 200));
const input = () => document.querySelector<HTMLInputElement>(".chat-search-input");
const type = (value: string) => {
  input()!.value = value;
  input()!.dispatchEvent(new InputEvent("input", { bubbles: true }));
};
const press = (key: string, init: KeyboardEventInit = {}) =>
  input()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const close = () => press("Escape");
const results = () => document.querySelector(".chat-search-results")?.textContent ?? "";
const chatRows = () =>
  [...document.querySelectorAll(".chat-search-row")]
    .filter((row) => row.querySelector(".chat-search-who.user, .chat-search-who.agent"))
    .map((row) => row.querySelector(".chat-search-snippet")!.textContent);
const resourceRows = () =>
  [...document.querySelectorAll(".chat-search-row:not(.chat-search-ask)")]
    .filter((row) => !row.querySelector(".chat-search-who.user, .chat-search-who.agent"))
    .map((row) => row.querySelector(".chat-search-snippet")!.textContent);
const asked = () => document.querySelector("main")!.textContent!.includes("Find the chat");
const hit = (sessionId: string) => ({ sessionId, entryType: "user", snippet: `${sessionId} text`, createdAt: 1 });
const resource = (title: string) => ({ kind: "skills", id: title.toLowerCase(), title, snippet: "" });

for (const outcome of ["resolve", "reject"] as const) {
  test(`typing invalidates an old ${outcome} before the next debounce fires`, async () => {
    type("old");
    await fire();
    type("document");
    assert.equal(requests[0]!.signal.aborted, true);
    if (outcome === "resolve") requests[0]!.resolve({ hits: [hit("old")] });
    else requests[0]!.reject(new Error("timeout"));
    await settle();
    assert.deepEqual(chatRows(), []);
    assert.doesNotMatch(results(), /Search failed/);
    assert.match(results(), /Searching…/);
    await fire();
    requests[1]!.resolve({ hits: [hit("document")] });
    await settle();
    assert.deepEqual(chatRows(), ["document text"]);
    assert.doesNotMatch(results(), /Searching…/);
  });
}

test("new input clears selectable stale hits and previous errors", async () => {
  type("old");
  await fire();
  requests[0]!.resolve({ hits: [hit("old")] });
  await settle();
  assert.deepEqual(chatRows(), ["old text"]);
  type("older");
  assert.deepEqual(chatRows(), []);
  await fire();
  requests[1]!.reject(new Error("timeout"));
  await settle();
  assert.match(results(), /Search failed/);
  type("document");
  assert.deepEqual(chatRows(), []);
  assert.doesNotMatch(results(), /Search failed/);
});

test("closing and reopening cannot accept a previous request", async () => {
  type("old");
  await fire();
  close();
  openChatSearch();
  requests[0]!.resolve({ hits: [hit("old")] });
  await settle();
  assert.deepEqual(chatRows(), []);
  assert.equal(input()!.value, "");
  press("Enter");
  await settle();
  assert.deepEqual(opened, []);
});

test("clearing the query cancels pending and in-flight searches", async () => {
  type("old");
  await fire();
  type("document");
  type("");
  await fire();
  assert.equal(requests.length, 1);
  requests[0]!.resolve({ hits: [hit("old")] });
  await settle();
  assert.deepEqual(chatRows(), []);
  assert.doesNotMatch(results(), /Searching…/);
  press("Enter");
  await settle();
  assert.deepEqual(opened, []);
});

test("Enter while searching does not start an unintended agent conversation", async () => {
  type("document");
  press("Enter");
  await settle();
  assert.equal(asked(), false);
});

test("Enter opens resources before chats and offsets chat selection correctly", async () => {
  type("zzq");
  await fire();
  resourceRequests[0]!.resolve({ hits: [resource("Skill")], failed: [] });
  await settle();
  press("Enter");
  assert.deepEqual(opened, ["/skills/skill"]);
  openChatSearch();
  type("zzq");
  await fire();
  resourceRequests[1]!.resolve({ hits: [resource("Skill")], failed: [] });
  requests[1]!.resolve({ hits: [hit("chat1")] });
  await settle();
  press("ArrowDown");
  press("Enter");
  await settle();
  assert.deepEqual(opened, ["/skills/skill", "chat1"]);
  openChatSearch();
  type("zzq");
  await fire();
  resourceRequests[2]!.resolve({ hits: [resource("Skill")], failed: [] });
  requests[2]!.resolve({ hits: [hit("chat1")] });
  await settle();
  press("ArrowDown");
  press("ArrowDown");
  press("Enter");
  await settle();
  assert.equal(asked(), true);
});

test("chat results do not wait for resource results, and stale resource replies are ignored", async () => {
  type("old");
  await fire();
  requests[0]!.resolve({ hits: [hit("old")] });
  await settle();
  assert.deepEqual(chatRows(), ["old text"]);
  type("new");
  await fire();
  resourceRequests[0]!.resolve({ hits: [resource("Old")], failed: [] });
  await settle();
  assert.deepEqual(resourceRows(), []);
  resourceRequests[1]!.resolve({ hits: [resource("New")], failed: [] });
  await settle();
  assert.deepEqual(resourceRows(), ["New"]);
  assert.match(results(), /Searching…/);
});

test("closing search aborts both requests and prevents old resources reappearing after reopen", async () => {
  type("old");
  await fire();
  close();
  openChatSearch();
  assert.equal(resourceRequests[0]!.signal.aborted, true);
  resourceRequests[0]!.resolve({ hits: [resource("Old")], failed: [] });
  await settle();
  assert.deepEqual(resourceRows(), []);
});

for (const navigate of [false, true]) {
  test(`late resources preserve the ${navigate ? "keyboard-selected" : "first"} chat`, async () => {
    type("zzq");
    await fire();
    requests[0]!.resolve({ hits: [hit("first"), hit("second")] });
    await settle();
    if (navigate) press("ArrowDown");
    resourceRequests[0]!.resolve({ hits: [resource("One"), resource("Two")], failed: [] });
    await settle();
    press("Enter");
    await settle();
    assert.deepEqual(opened, [navigate ? "second" : "first"]);
  });
}

for (const first of ["chats", "resources"] as const) {
  test(`late ${first === "chats" ? "resources" : "chats"} preserve the explicitly selected ask row`, async () => {
    type("zzq");
    await fire();
    const chats = { hits: [hit("chat")] };
    const resources = { hits: [resource("Resource")], failed: [] };
    if (first === "chats") requests[0]!.resolve(chats);
    else resourceRequests[0]!.resolve(resources);
    await settle();
    press("ArrowDown");
    if (first === "chats") resourceRequests[0]!.resolve(resources);
    else requests[0]!.resolve(chats);
    await settle();
    press("Enter");
    await settle();
    assert.equal(asked(), true);
    assert.deepEqual(opened, []);
  });
}

test("initial resources select the first result instead of retaining the default ask row", async () => {
  type("zzq");
  await fire();
  resourceRequests[0]!.resolve({ hits: [resource("Resource")], failed: [] });
  await settle();
  press("Enter");
  assert.deepEqual(opened, ["/skills/resource"]);
});
