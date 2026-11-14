import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";
import type { AppView } from "../src/app-view.ts";

let requests: Array<{ path: string; resolve: (body: unknown) => void }> = [];
const { vite, close } = await browserEnv({
  dom: { url: "http://localhost/apps" },
  fetch: (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Promise.resolve(Response.json({ contexts: [] }));
    return new Promise<Response>((resolve) => requests.push({ path, resolve: (body) => resolve(Response.json(body)) }));
  },
});
after(close);

let appState: {
  currentView: string;
  viewRenderSeq: number;
  mainEl: HTMLElement | null;
  me: { user: string; org: string } | null;
};
let renderApps: () => Promise<void>;
let openAppById: (id: string) => void;
let main: HTMLElement;

beforeEach(async () => {
  requests = [];
  document.body.innerHTML = '<div id="app"></div><main></main>';
  main = document.querySelector("main")!;
  vite.moduleGraph.invalidateAll();
  ({ appState } = await vite.ssrLoadModule("/src/shell.ts"));
  ({ renderApps, openAppById } = await vite.ssrLoadModule("/src/apps-page.ts"));
  appState.currentView = "apps";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "test" };
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = (path: string) => {
  const found = requests.find((r) => r.path === path);
  assert.ok(found, `requested ${path}`);
  return found;
};
const listedIds = () =>
  [...main.querySelectorAll(".app-row .list-row-title")].map((row) => row.textContent?.trim() ?? "");
const detail = () => main.querySelector(".app-detail-pane");
const loadingDetail = () => Boolean(detail()?.querySelector(".hint")?.textContent?.includes("Loading"));

test("the initial list refresh redraws the list when no detail was opened", async () => {
  const rendering = renderApps();
  await settle();
  assert.match(main.textContent ?? "", /Loading apps…/);
  request("/api/apps").resolve({ apps: [{ id: "app", ownerScopeId: "personal:tester" }] });
  await rendering;
  assert.deepEqual(listedIds(), ["app"]);
});

test("the initial list refresh leaves an opened detail and its loading state untouched", async () => {
  const first = renderApps();
  await settle();
  request("/api/apps").resolve({ apps: [{ id: "opened-app", ownerScopeId: "personal:tester" }] });
  await first;
  requests = [];
  const rendering = renderApps();
  await settle();
  main.querySelector<HTMLButtonElement>(".app-manage")!.click();
  await settle();
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/api/apps", "/api/apps/opened-app"],
  );
  request("/api/apps").resolve({ apps: [] });
  await rendering;
  assert.equal(listedIds().length, 0);
  assert.ok(loadingDetail());
  request("/api/apps/opened-app").resolve({ app: { id: "opened-app", displayName: "Opened" } });
  await settle();
  assert.equal(detail()?.querySelector("h2")?.textContent, "Opened");
  assert.equal(loadingDetail(), false);
});

for (const listed of [false, true]) {
  test(`app deep links load details when the requested app is ${listed ? "in" : "absent from"} the list`, async () => {
    openAppById("linked-app");
    const rendering = renderApps();
    await settle();
    request("/api/apps").resolve({
      apps: listed ? [{ id: "linked-app", displayName: "Linked app" }] : [],
    });
    await settle();
    assert.ok(request("/api/apps/linked-app"));
    assert.ok(loadingDetail());
    request("/api/apps/linked-app").resolve({ app: { id: "linked-app" } });
    await rendering;
    assert.ok(detail());
    assert.equal(loadingDetail(), false);
  });
}

for (const supersede of ["view", "render"] as const) {
  test(`a pending app deep link cannot open after another ${supersede}`, async () => {
    openAppById("linked-app");
    const rendering = renderApps();
    await settle();
    if (supersede === "view") appState.currentView = "skills";
    else appState.viewRenderSeq++;
    request("/api/apps").resolve({ apps: [{ id: "linked-app" }] });
    await rendering;
    assert.deepEqual(
      requests.map((r) => r.path),
      ["/api/apps"],
    );
    assert.equal(detail(), null);
  });
}

async function openDetail(publishedApp: AppView): Promise<HTMLElement> {
  openAppById(publishedApp.id);
  const rendering = renderApps();
  await settle();
  request("/api/apps").resolve({ apps: [] });
  await settle();
  request(`/api/apps/${publishedApp.id}`).resolve({ app: publishedApp });
  await rendering;
  return detail() as HTMLElement;
}

test("the detail page shows the URL core gives the app, not one built from its slug", async () => {
  const pane = await openDetail({
    id: "linked",
    name: "sales",
    status: "running",
    permission: "write",
    webUrl: "https://acme-sales.apps.example.com/",
  });
  assert.equal(pane.querySelector(".app-detail-url")?.textContent, "https://acme-sales.apps.example.com/");
  const urlSetting = [...pane.querySelectorAll(".app-setting-row")].find((row) => row.textContent?.includes("App URL"));
  assert.equal(urlSetting?.querySelector("code")?.textContent, "https://acme-sales.apps.example.com/");
});

for (const count of [0, 7, 23, 150]) {
  test(`version history reveals ${count} versions in newest-first batches of ten`, async () => {
    const publishedApp = {
      id: "history-app",
      currentVersion: count,
      appliedVersion: 1,
      versions: Array.from({ length: count }, (_, index) => ({ version: index + 1, createdAt: 1000 })),
    };
    const pane = await openDetail(publishedApp);
    const history = () =>
      [...pane.querySelectorAll(".app-detail-section")].find(
        (s) => s.querySelector("h3")?.textContent === "Version history",
      )!;
    const olderButton = () =>
      [...history().querySelectorAll("button")].find((b) => b.textContent?.includes("Show older versions"));
    let shown = 10;
    for (;;) {
      const section = history();
      const numbers = [...section.querySelectorAll(".app-version-row strong")].map((s) =>
        Number(s.textContent!.slice(1)),
      );
      assert.deepEqual(
        numbers,
        Array.from({ length: Math.min(shown, count) }, (_, index) => count - index),
      );
      assert.equal(section.textContent!.includes("No version history available."), count === 0);
      assert.equal(Boolean(section.querySelector(".badge.ok")), count > 0 && shown >= count);
      assert.equal(
        [...section.querySelectorAll(".badge")].some((b) => b.textContent === "Latest"),
        count > 1,
      );
      assert.equal(Boolean(olderButton()), shown < count);
      if (shown >= count) break;
      olderButton()!.click();
      shown += 10;
    }
    assert.deepEqual(
      publishedApp.versions.map((version) => version.version),
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });
}

test("detail redraws reuse the scroll container and retain focus", async () => {
  openAppById("app");
  const rendering = renderApps();
  await settle();
  request("/api/apps").resolve({ apps: [] });
  await settle();
  const host = detail() as HTMLElement;
  const button = host.querySelector<HTMLButtonElement>("button")!;
  host.scrollTop = 450;
  button.focus();
  request("/api/apps/app").resolve({ app: { id: "app", displayName: "App" } });
  await rendering;
  assert.equal(loadingDetail(), false);
  assert.equal(main.firstElementChild, host);
  assert.equal(host.scrollTop, 450);
  assert.equal(document.activeElement, button);
});

test("the grid view shows a card per app and is remembered across visits", async () => {
  localStorage.removeItem("qm.apps.layout");
  const rendering = renderApps();
  await settle();
  request("/api/apps").resolve({
    apps: [
      { id: "a", name: "launch-dashboard", status: "running", webUrl: "/d/a/", ownerScopeId: "personal:tester" },
      { id: "b", name: "notes", status: "stopped", ownerScopeId: "personal:tester" },
    ],
  });
  await rendering;
  main.querySelector<HTMLButtonElement>('[aria-label="Grid view"]')!.click();
  const cards = [...main.querySelectorAll(".app-card")];
  assert.deepEqual(
    cards.map((card) => card.querySelector(".app-card-icon")?.textContent),
    ["LD", "NO"],
  );
  assert.equal(cards[0]!.querySelector("a.app-card-thumb")?.getAttribute("href"), "/d/a/");
  assert.equal(cards[1]!.querySelector("a.app-card-thumb"), null);
  assert.equal(localStorage.getItem("qm.apps.layout"), "grid");
  localStorage.removeItem("qm.apps.layout");
});
