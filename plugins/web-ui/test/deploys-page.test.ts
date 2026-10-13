import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";
import type { DeploymentView } from "../src/deploy-view.ts";

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
let renderDeploys: () => Promise<void>;
let openDeployById: (id: string) => void;
let main: HTMLElement;

beforeEach(async () => {
  requests = [];
  document.body.innerHTML = '<div id="app"></div><main></main>';
  main = document.querySelector("main")!;
  vite.moduleGraph.invalidateAll();
  ({ appState } = await vite.ssrLoadModule("/src/shell.ts"));
  ({ renderDeploys, openDeployById } = await vite.ssrLoadModule("/src/deploys.ts"));
  appState.currentView = "deploys";
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
  [...main.querySelectorAll(".deploy-row .list-row-title")].map((row) => row.textContent?.trim() ?? "");
const detail = () => main.querySelector(".deploy-detail-pane");
const loadingDetail = () => Boolean(detail()?.querySelector(".hint")?.textContent?.includes("Loading"));

test("the initial list refresh redraws the list when no detail was opened", async () => {
  const rendering = renderDeploys();
  await settle();
  assert.match(main.textContent ?? "", /Loading apps…/);
  request("/api/deployments").resolve({ deployments: [{ id: "app", ownerScopeId: "personal:tester" }] });
  await rendering;
  assert.deepEqual(listedIds(), ["app"]);
});

test("the initial list refresh leaves an opened detail and its loading state untouched", async () => {
  const first = renderDeploys();
  await settle();
  request("/api/deployments").resolve({ deployments: [{ id: "opened-app", ownerScopeId: "personal:tester" }] });
  await first;
  requests = [];
  const rendering = renderDeploys();
  await settle();
  main.querySelector<HTMLButtonElement>(".deploy-manage")!.click();
  await settle();
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/api/deployments", "/api/deployments/opened-app"],
  );
  request("/api/deployments").resolve({ deployments: [] });
  await rendering;
  assert.equal(listedIds().length, 0);
  assert.ok(loadingDetail());
  request("/api/deployments/opened-app").resolve({ deployment: { id: "opened-app", displayName: "Opened" } });
  await settle();
  assert.equal(detail()?.querySelector("h2")?.textContent, "Opened");
  assert.equal(loadingDetail(), false);
});

for (const listed of [false, true]) {
  test(`app deep links load details when the requested app is ${listed ? "in" : "absent from"} the list`, async () => {
    openDeployById("linked-app");
    const rendering = renderDeploys();
    await settle();
    request("/api/deployments").resolve({
      deployments: listed ? [{ id: "linked-app", displayName: "Linked app" }] : [],
    });
    await settle();
    assert.ok(request("/api/deployments/linked-app"));
    assert.ok(loadingDetail());
    request("/api/deployments/linked-app").resolve({ deployment: { id: "linked-app" } });
    await rendering;
    assert.ok(detail());
    assert.equal(loadingDetail(), false);
  });
}

for (const supersede of ["view", "render"] as const) {
  test(`a pending app deep link cannot open after another ${supersede}`, async () => {
    openDeployById("linked-app");
    const rendering = renderDeploys();
    await settle();
    if (supersede === "view") appState.currentView = "skills";
    else appState.viewRenderSeq++;
    request("/api/deployments").resolve({ deployments: [{ id: "linked-app" }] });
    await rendering;
    assert.deepEqual(
      requests.map((r) => r.path),
      ["/api/deployments"],
    );
    assert.equal(detail(), null);
  });
}

async function openDetail(deployment: DeploymentView): Promise<HTMLElement> {
  openDeployById(deployment.id);
  const rendering = renderDeploys();
  await settle();
  request("/api/deployments").resolve({ deployments: [] });
  await settle();
  request(`/api/deployments/${deployment.id}`).resolve({ deployment });
  await rendering;
  return detail() as HTMLElement;
}

for (const count of [0, 7, 23, 150]) {
  test(`version history reveals ${count} versions in newest-first batches of ten`, async () => {
    const deployment = {
      id: "history-app",
      currentVersion: count,
      appliedVersion: 1,
      versions: Array.from({ length: count }, (_, index) => ({ version: index + 1, createdAt: 1000 })),
    };
    const pane = await openDetail(deployment);
    const history = () =>
      [...pane.querySelectorAll(".deploy-detail-section")].find(
        (s) => s.querySelector("h3")?.textContent === "Version history",
      )!;
    const olderButton = () =>
      [...history().querySelectorAll("button")].find((b) => b.textContent?.includes("Show older versions"));
    let shown = 10;
    for (;;) {
      const section = history();
      const numbers = [...section.querySelectorAll(".deploy-version-row strong")].map((s) =>
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
      deployment.versions.map((version) => version.version),
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });
}

test("detail redraws reuse the scroll container and retain focus", async () => {
  openDeployById("app");
  const rendering = renderDeploys();
  await settle();
  request("/api/deployments").resolve({ deployments: [] });
  await settle();
  const host = detail() as HTMLElement;
  const button = host.querySelector<HTMLButtonElement>("button")!;
  host.scrollTop = 450;
  button.focus();
  request("/api/deployments/app").resolve({ deployment: { id: "app", displayName: "App" } });
  await rendering;
  assert.equal(loadingDetail(), false);
  assert.equal(main.firstElementChild, host);
  assert.equal(host.scrollTop, 450);
  assert.equal(document.activeElement, button);
});
