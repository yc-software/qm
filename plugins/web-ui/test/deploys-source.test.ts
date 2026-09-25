import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { createContext, runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { deploymentListRefreshCanRedraw, type DeploymentView } from "../src/deploy-view.ts";
import {
  withDeploymentListNotice,
  withDeploymentDetailNotice,
  withoutDeploymentDetailNotice,
} from "../src/deploy-notices.ts";
import { deepLinkPath } from "../src/deep-link.ts";

const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("app index rows launch live apps by default and use Manage for app details", () => {
  const row = bodyOf("deploymentRow");
  const title = row.slice(row.indexOf("const title"), row.indexOf("return html`"));
  assert.doesNotMatch(
    row,
    /deploy-row-url|deploy-row-meta|ownerLabel|permissionBadge|versionLabel|deployedLabel|Copy app URL/,
  );
  assert.match(row, /deploymentTitle\(d\)/);
  assert.match(row, /statusLabel\(d\)/);
  assert.match(row, /running && d\.webUrl/);
  assert.match(row, /href=\$\{withBase\(d\.webUrl\)\}/);
  assert.match(row, /target="_blank"/);
  assert.match(row, /class="deploy-row-actions"[\s\S]*class="deploy-status/);
  assert.doesNotMatch(title, /deploy-status/);
  assert.match(row, /class="btn deploy-manage"[\s\S]*@click=\$\{\(\) => void openDeploy\(d\)\}/);
  assert.doesNotMatch(row, /deploy-menu|More actions/);
  assert.doesNotMatch(row, />Open \$\{icon\(ExternalLink/);
  assert.match(css, /\.deploy-row-main\[href\]::after \{\s*position: absolute;\s*inset: 0;/);
  assert.match(css, /\.deploy-row-actions \{\s*position: relative;\s*z-index: 1;/);
});

test("app index header keeps search and tabs without secondary controls", () => {
  const draw = bodyOf("drawDeploysPage");
  assert.doesNotMatch(draw, /onScope:|action:|controls:|deploySort|Deploy with Agent/);
  assert.match(draw, /placeholder: "Search apps"/);
  assert.match(draw, /deployTabs\(\)/);
});

test("the global Apps route clears a scope inherited from an earlier scoped visit", () => {
  assert.match(source, /else \{\s*deployScope = null;\s*\}/);
});

test("app index content uses the shared centered layout", () => {
  assert.doesNotMatch(
    css,
    /\.deploys-page \.list-page-head,\s*\.deploys-page \.list-search,\s*\.deploys-page \.list-rows \{\s*margin-right: 0;\s*margin-left: 0;/,
  );
  assert.match(
    css,
    /\.deploy-row-main \{\s*min-width: 0;\s*display: flex;\s*flex-direction: row;\s*align-items: center;\s*justify-content: flex-start;/,
  );
});

test("Deploys consumes and clears context deep-link handoff state", () => {
  assert.match(source, /deployScope = contextsState\.selected;\s+contextsState\.selected = null;/);
});

test("Deploys clears archive overlay state when the view is entered", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /archiveCandidate = null;\s+restoreArchiveFocus = false;\s+setDeployBackgroundInert\(false\);/);
  assert.match(source, /appState\.currentView !== "deploys" \|\| archiveCandidate\?\.id !== d\.id/);
});

test("archive focus restoration yields to a newly opened dialog", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /restoreArchiveFocus = false;\s+drawCurrentDeployView\(\);/);
  assert.match(source, /appState\.currentView !== "deploys" \|\| archiveCandidate/);
});

test("archive confirmation synchronously makes background actions inert", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /archiveCandidate = d;\s+drawCurrentDeployView\(\);\s+setDeployBackgroundInert\(true\);/);
  assert.match(source, /\.deploy-detail, \.deploy-toast/);
});

test("deployment mutations re-check their target after asynchronous work", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /const restoringActive = activeDeploy\?\.id === d\.id;/);
  assert.match(source, /function currentDeployActionView\(targetId: string\)/);
  assert.equal(source.match(/currentDeployActionView\(d\.id\)/g)?.length, 6);
});

test("a restored deployment replaces its stale archived list row when refresh fails", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deployList = deploymentListAfterRestoreRefresh\(deployList, restored, refreshResult\);/);
  assert.match(source, /return "superseded";/);
});

test("list refreshes cannot clear detail-scoped errors", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deployNotices\.detail\?\.id === d\.id/);
  assert.match(source, /deployNotices = withDeploymentListNotice\(deployNotices, ""\);/);
  assert.doesNotMatch(source, /deployDetailNotice|deployListNotice/);
});

function renderHarness(requestedId: string | null = null) {
  const requests: Array<{ path: string; resolve: (response: unknown) => void }> = [];
  const frames: Array<{ view: "list" | "detail"; id?: string; loading?: boolean }> = [];
  const context = createContext({
    appState: { currentView: "deploys", viewRenderSeq: 1 },
    pendingDeployId: requestedId,
    archiveCandidate: null,
    restoreArchiveFocus: false,
    scopedSession: { active: null },
    contextsState: { selected: null },
    deployScope: null,
    deployList: [],
    deployLoading: false,
    deployNotices: { list: "", detail: null },
    activeDeploy: null,
    visibleVersionCount: 70,
    editingDeploy: null,
    deployDraft: "",
    deployRefreshSeq: 0,
    setDeployBackgroundInert() {},
    async ensureContexts() {},
    withDeploymentListNotice,
    withDeploymentDetailNotice,
    withoutDeploymentDetailNotice,
    deploymentListRefreshCanRedraw,
    deepLinkPath,
    UI_BASE: "",
    history: { replaceState() {} },
    errMessage: (error: Error) => error.message,
    drawDeploysPage() {
      frames.push({ view: "list" });
    },
    drawDeployDetail(deployment: DeploymentView, loading = false) {
      frames.push({ view: "detail", id: deployment.id, loading });
    },
    api: (path: string) => new Promise((resolve) => requests.push({ path, resolve })),
  });
  const open = source.slice(source.indexOf("async function openDeploy("), source.indexOf("function drawDeployDetail("));
  const refreshAndRender = source
    .slice(source.indexOf("async function refreshDeployments("))
    .replace("export async function", "async function");
  runInContext(stripTypeScriptTypes(open + refreshAndRender), context);
  return {
    context,
    requests,
    frames,
    render: () => runInContext("renderDeploys()", context) as Promise<void>,
    open: () => runInContext('openDeploy({id: "opened-app"})', context) as Promise<void>,
  };
}

test("the initial list refresh redraws the list when no detail was opened", async () => {
  const h = renderHarness();
  const rendering = h.render();
  await new Promise((resolve) => setImmediate(resolve));
  h.requests[0]!.resolve({ deployments: [{ id: "app" }] });
  await rendering;
  assert.deepEqual(h.frames, [{ view: "list" }, { view: "list" }]);
});

test("the initial list refresh leaves an opened detail and its loading state untouched", async () => {
  const h = renderHarness();
  const rendering = h.render();
  await new Promise((resolve) => setImmediate(resolve));
  const opening = h.open();
  assert.equal(h.context.visibleVersionCount, 10);
  assert.equal(h.requests[0]!.path, "/api/deployments");
  assert.equal(h.requests[1]!.path, "/api/deployments/opened-app");
  h.requests[0]!.resolve({ deployments: [] });
  await rendering;
  assert.deepEqual(h.frames, [{ view: "list" }, { view: "detail", id: "opened-app", loading: true }]);
  h.requests[1]!.resolve({ deployment: { id: "opened-app" } });
  await opening;
  assert.deepEqual(h.frames.at(-1), { view: "detail", id: "opened-app", loading: false });
});

for (const listed of [false, true]) {
  test(`app deep links load details when the requested app is ${listed ? "in" : "absent from"} the list`, async () => {
    const h = renderHarness("linked-app");
    const rendering = h.render();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.context.pendingDeployId, null);
    h.requests[0]!.resolve({ deployments: listed ? [{ id: "linked-app", displayName: "Linked app" }] : [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.requests[1]!.path, "/api/deployments/linked-app");
    assert.deepEqual(h.frames.at(-1), { view: "detail", id: "linked-app", loading: true });
    h.requests[1]!.resolve({ deployment: { id: "linked-app" } });
    await rendering;
    assert.deepEqual(h.frames.at(-1), { view: "detail", id: "linked-app", loading: false });
  });
}

for (const supersede of ["view", "render"] as const) {
  test(`a pending app deep link cannot open after another ${supersede}`, async () => {
    const h = renderHarness("linked-app");
    const rendering = h.render();
    await new Promise((resolve) => setImmediate(resolve));
    if (supersede === "view") h.context.appState.currentView = "skills";
    else h.context.appState.viewRenderSeq++;
    h.requests[0]!.resolve({ deployments: [{ id: "linked-app" }] });
    await rendering;
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.frames, [{ view: "list" }]);
  });
}

test("the empty Yours tab does not imply the account has no deployments", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deploymentTabEmptyMessage\(deployTab\)/);
  assert.doesNotMatch(source, /No deployments yet\./);
  const messages = readFileSync(new URL("../src/deploy-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(messages, /You have no apps\./);
});

for (const count of [0, 7, 23, 150]) {
  test(`version history reveals ${count} versions in newest-first batches of ten`, () => {
    const deployment = {
      id: "history-app",
      currentVersion: count,
      appliedVersion: 1,
      versions: Array.from({ length: count }, (_, index) => ({ version: index + 1, createdAt: 1000 })),
    };
    const handlers: Array<() => void> = [];
    const redraws: unknown[] = [];
    const context = createContext({
      d: deployment,
      nothing: "",
      drawDeployDetail: (value: unknown) => redraws.push(value),
      html(strings: TemplateStringsArray, ...values: unknown[]) {
        const text = (value: unknown): string => {
          if (typeof value === "function") {
            handlers.push(value as () => void);
            return "";
          }
          return Array.isArray(value) ? value.map(text).join("") : String(value);
        };
        return strings.reduce(
          (result, part, index) => result + part + (index < values.length ? text(values[index]) : ""),
          "",
        );
      },
    });
    const initialCount = source.match(/let visibleVersionCount = \d+;/)?.[0];
    const orderedVersions = bodyOf("drawDeployDetail").match(/const versions = [^;]+;/)?.[0];
    const section = source.match(
      /<section class="deploy-detail-section">\s*<h3>Version history<\/h3>[\s\S]*?<\/section>/,
    )?.[0];
    assert.ok(initialCount && orderedVersions && section);
    runInContext(stripTypeScriptTypes(initialCount + orderedVersions), context);
    let shown = 10;
    for (;;) {
      handlers.length = 0;
      const rendered = runInContext(stripTypeScriptTypes(`html\`${section}\``), context) as string;
      const numbers = [...rendered.matchAll(/<strong>v(\d+)<\/strong/g)].map((match) => Number(match[1]));
      assert.deepEqual(
        numbers,
        Array.from({ length: Math.min(shown, count) }, (_, index) => count - index),
      );
      assert.equal(rendered.includes("No version history available."), count === 0);
      assert.equal(rendered.includes('class="badge ok">Live'), count > 0 && shown >= count);
      assert.equal(rendered.includes('class="badge">Latest'), count > 1);
      assert.equal(rendered.includes("Show older versions"), shown < count);
      assert.equal(handlers.length, shown < count ? 1 : 0);
      if (shown >= count) break;
      handlers[0]!();
      assert.equal(redraws.at(-1), deployment);
      shown += 10;
    }
    assert.deepEqual(
      deployment.versions.map((version) => version.version),
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });
}

test("detail redraws reuse the scroll container and retain focus", () => {
  const dom = new JSDOM("<main></main>");
  try {
    const mainEl = dom.window.document.querySelector("main")!;
    const deployment = { id: "app" };
    const context = createContext({
      appState: { currentView: "deploys", mainEl },
      document: dom.window.document,
      d: deployment,
      activeDeploy: deployment,
      editingDeploy: null,
      deployNotices: {},
      archiveCandidate: null,
      deployToast: null,
      visibleVersionCount: 10,
      nothing: "",
      html: () => "",
      render(_template: unknown, host: HTMLElement) {
        if (!host.firstChild) host.append(dom.window.document.createElement("button"));
      },
      deploymentContextScope: () => null,
      listBackLink: () => "",
      returnToDeploysList() {},
      deploymentTitle: () => "App",
      statusClass: () => "",
      statusLabel: () => "",
      deploymentSlug: () => "app",
      deploymentLatestAt: () => null,
      ownerLabel: () => "",
      permissionBadge: () => "",
      canManage: () => false,
    });
    runInContext(stripTypeScriptTypes(bodyOf("drawDeployDetail")), context);
    runInContext("drawDeployDetail(d)", context);
    const host = mainEl.firstElementChild as HTMLElement;
    const button = host.querySelector("button")!;
    host.scrollTop = 450;
    button.focus();
    runInContext("drawDeployDetail(d)", context);
    assert.equal(mainEl.firstElementChild, host);
    assert.equal(host.scrollTop, 450);
    assert.equal(dom.window.document.activeElement, button);
  } finally {
    dom.window.close();
  }
});
