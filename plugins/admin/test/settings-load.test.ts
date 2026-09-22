import { litFixture } from "./lit-fixture.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { setImmediate } from "node:timers/promises";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const extract = (start: string, end: string) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
};

test("settings navigation never starts the all-scopes history scan", () => {
  const source = extract("function render(st) {", "const GOV_LIKE =");
  for (const view of ["customize", "models", "credentials", "governance", "connectors", "onboarding", "history"]) {
    let scans = 0;
    let settings = 0;
    const node = { classList: { toggle() {} } };
    const context = vm.createContext({
      governanceUI: { transcript: { cancel() {} } },
      transcriptObserver: null,
      adminPreviewTheme: null,
      syncAdminTheme() {},
      governanceReadyScope: "org:example",
      setGovernancePending() {},
      scopeDir: null,
      document: { body: { dataset: {}, ...node }, documentElement: { style: { removeProperty() {} } } },
      $: () => node,
      isGovLike: (view: string) => ["customize", "models", "credentials", "governance"].includes(view),
      loadScopeDirectory: () => {
        scans++;
      },
      loadScope: () => {
        settings++;
      },
      loadConnectors: () => {
        settings++;
      },
      loadOnboarding: () => {
        settings++;
      },
      renderTabs() {},
      defaultShell() {},
      renderCurrentData() {},
    });
    vm.runInContext(source, context);
    vm.runInContext(`render({view:${JSON.stringify(view)}, scope:"org:example"})`, context);
    assert.equal(scans, view === "history" ? 1 : 0, view);
    assert.equal(settings, view === "history" ? 0 : 1, view);
  }
});

test("catalog completion appends options only to the requesting settings view", async () => {
  const source = extract("if (r.data.modelCatalogRefreshing) {", "\n      }\n      async function refreshSoulConflict");
  for (const stale of [false, true]) {
    const completion = Promise.withResolvers<unknown>();
    const options = [{ id: "configured", name: "Configured" }];
    const harnessOptions = [...options];
    let rendered = 0;
    const context = vm.createContext({
      r: { data: { modelCatalogRefreshing: true } },
      requestId: 1,
      governanceReq: 1,
      requestedScope: "org:example",
      scope: "org:example",
      requestedView: "models",
      view: "models",
      opts: options,
      modelsByHarness: { pi: harnessOptions },
      refreshModelChoices: [
        () => {
          rendered++;
        },
      ],
      api: () => completion.promise,
      initCustomDropdowns() {},
      $() {},
      encodeURIComponent,
    });
    vm.runInContext(source, context);
    if (stale) context.view = "customize";
    completion.resolve({
      ok: true,
      data: {
        baseModelOptions: [{ id: "new", name: "New model" }],
        modelsByHarness: { pi: [{ id: "new", name: "New model" }] },
      },
    });
    await setImmediate();
    assert.deepEqual(
      options.map((model) => model.id),
      stale ? ["configured"] : ["configured", "new"],
    );
    assert.deepEqual(
      harnessOptions.map((model) => model.id),
      stale ? ["configured"] : ["configured", "new"],
    );
    assert.equal(rendered, stale ? 0 : 1);
  }
});

test("branding saves commit the Lit draft and preserve unrelated settings", async () => {
  const source = extract(
    'document.querySelectorAll("[data-save]").forEach',
    '$("view-governance").addEventListener("input"',
  );
  for (const otherDraft of [false, true]) {
    const f = litFixture();
    try {
      f.ui.settings.load(
        { branding: { selfLabel: "Saved name", accent: "#111111" }, soul: "Original SOUL" },
        "org:test",
      );
      f.ui.settings.states.get("branding").change("accent", "#123456");
      if (otherDraft) f.ui.settings.states.get("soul").change("content", "Unsaved SOUL");
      const body = f.ui.collect("branding");
      const snapshots = new Map();
      const requests: any[] = [];
      let reloads = 0;
      const button = f.document.createElement("button");
      button.dataset.save = "branding";
      f.root.append(button);
      const context = vm.createContext({
        document: f.document,
        governanceUI: f.ui,
        scope: "org:test",
        governanceReq: 1,
        governanceSaveSeq: 0,
        SAVE: { branding: () => f.ui.collect("branding") },
        SAVE_ST: { branding: "st-branding" },
        governanceSaveReview: async () => true,
        setStatus: (_id: string, message: string, tone: string) => f.ui.status("branding", message, tone),
        savedBranding: { selfLabel: "Saved name", accent: "#111111", iconUrl: "https://example.com/icon.png" },
        sectionSnapshots: snapshots,
        api: async (...args: any[]) => {
          requests.push(args);
          return { ok: true };
        },
        hasGovernanceDraft: () => [...f.ui.settings.states.values()].some((state: any) => state.dirty),
        location: { reload: () => reloads++ },
      });
      vm.runInContext(source, context);
      await button.onclick!(new f.window.PointerEvent("click"));
      assert.equal(requests.length, 1);
      assert.equal(requests[0][0], "PUT");
      assert.equal(requests[0][1], "/api/scopes/org%3Atest/branding");
      assert.equal(requests[0][2].selfLabel, "Saved name");
      assert.equal(requests[0][2].iconUrl, "https://example.com/icon.png");
      assert.equal(requests[0][2].accent, "#123456");
      assert.equal(context.savedBranding, requests[0][2]);
      assert.equal(snapshots.get("branding"), JSON.stringify(body));
      assert.equal(f.ui.states.get("branding").dirty, false);
      assert.equal(f.ui.states.get("soul").dirty, otherDraft);
      assert.equal(f.ui.collect("soul").content, otherDraft ? "Unsaved SOUL" : "Original SOUL");
      assert.equal(reloads, otherDraft ? 0 : 1);
    } finally {
      f.dom.window.close();
    }
  }
});

test("other settings projections leave the loaded Governance cards intact", () => {
  const load = html.slice(html.indexOf("async function loadScope()"));
  const start = load.indexOf('if (requestedView === "governance") {');
  const end = load.indexOf('if (requestedView === "customize")', start);
  const source = load.slice(start, end);
  for (const requestedView of ["customize", "models", "credentials", "slack-settings"]) {
    vm.runInNewContext(source, { requestedView });
  }
});

test("credential usage distinguishes loading, failure, and confirmed zero", () => {
  const f = litFixture();
  try {
    f.root.innerHTML = '<template data-settings-card="card-service-credentials"></template>';
    f.ui.settings.mountCards();
    for (const [usage, message] of [
      [{}, "Loading usage…"],
      [{ usageUnavailable: true }, "Usage unavailable"],
      [{ usageCount: 0 }, "0 successful uses in retained broker history"],
    ] as const) {
      f.ui.settings.loadCredentials([{ slug: "test", host: "example.com", ...usage }], [], [], [], "org:test");
      assert.ok(f.document.querySelector("#sc-list")!.textContent!.includes(message));
    }
  } finally {
    f.dom.window.close();
  }
});

test("usage completion preserves credentials on failure and ignores stale scope, view, and reload responses", async () => {
  for (const state of ["current", "failed", "scope", "view", "reload"]) {
    const pending = Promise.withResolvers<unknown>();
    let renders = 0;
    const context = vm.createContext({
      scope: "org:example",
      view: "credentials",
      governanceReq: 1,
      serviceCredList: [{ slug: "example", name: "Example", grantees: ["org:example"] }],
      api: () => pending.promise,
      renderServiceCreds: (list: unknown) => {
        renders++;
        context.serviceCredList = list;
      },
    });
    vm.runInContext(
      extract("async function loadServiceCredentialUsage(", "governanceUI.settings.configureCredentials("),
      context,
    );
    const work = vm.runInContext('loadServiceCredentialUsage("org:example", 1)', context);
    if (state === "scope") context.scope = "org:other";
    if (state === "view") context.view = "models";
    if (state === "reload") context.governanceReq = 2;
    pending.resolve(
      state === "failed" ? { ok: false } : { ok: true, data: { summaries: [{ slug: "example", usageCount: 7 }] } },
    );
    await work;
    assert.equal(renders, ["current", "failed"].includes(state) ? 1 : 0, state);
    assert.equal(context.serviceCredList[0].name, "Example");
    assert.equal(context.serviceCredList[0].usageCount, state === "current" ? 7 : undefined);
    assert.equal(
      context.serviceCredList[0].usageUnavailable,
      ({ failed: true, current: false } as Record<string, boolean>)[state],
    );
  }
});

test("credential request displays loading, then a visible retry on failure", async () => {
  const f = litFixture();
  try {
    f.root.innerHTML = '<template data-settings-card="card-service-credentials"></template>';
    f.ui.settings.mountCards();
    const pending = Promise.withResolvers<unknown>();
    let retries = 0;
    f.ui.settings.configureCredentials({ reload: () => retries++, label: String, formatTime: String });
    const context = vm.createContext({
      scope: "org:example",
      view: "credentials",
      governanceReq: 0,
      loadedGovernanceScope: null,
      serviceCredList: [{ slug: "stale" }],
      governanceUI: f.ui,
      loadPersonalKeychainSummary() {},
      setStatus() {},
      api: () => pending.promise,
    });
    const source = extract("async function loadScope() {", "        const refreshModelChoices = [];");
    vm.runInContext(source + "}", context);
    const work = vm.runInContext("loadScope()", context);
    assert.equal(f.document.querySelector("#sc-list")!.textContent!.trim(), "Loading credentials…");
    assert.equal((f.document.querySelector("#sc-add") as HTMLButtonElement).disabled, true);
    assert.equal(context.serviceCredList.length, 0);
    pending.resolve({ ok: false, status: 500 });
    await work;
    assert.ok(f.document.querySelector("#sc-list")!.textContent!.includes("Could not load credentials."));
    f.document.querySelector<HTMLButtonElement>("#sc-list button")!.click();
    assert.equal(retries, 1);
  } finally {
    f.dom.window.close();
  }
});

test("admin requests convert rejected fetches and interrupted bodies into failure states", async () => {
  for (const fetch of [
    async () => {
      throw new Error("network disconnected");
    },
    async () => ({
      text: async () => {
        throw new Error("body interrupted");
      },
    }),
  ]) {
    const context = vm.createContext({ fetch, API_BASE: "" });
    vm.runInContext(extract("async function api(", "async function openWebUiAs("), context);
    const result = await vm.runInContext('api("GET", "/api/scopes/org:example")', context);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.data.message, "Network request failed.");
  }
});

test("admin shell calls resolve against the shipped Lit bundle", () => {
  const f = litFixture();
  try {
    const calls = [...html.matchAll(/governanceUI((?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)];
    assert.ok(calls.length > 0);
    for (const [, path] of calls) {
      const value = path!
        .slice(1)
        .split(".")
        .reduce((owner: any, key) => owner?.[key], f.ui);
      assert.equal(typeof value, "function", `governanceUI${path}`);
    }
  } finally {
    f.dom.window.close();
  }
});
