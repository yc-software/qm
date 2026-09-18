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
      transcriptObserver: null,
      scopeDir: null,
      document: { body: { dataset: {}, ...node } },
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

test("branding reload clears only the committed draft and preserves other unsaved settings", () => {
  const source = extract('} else if (key === "branding") {', "} else if (SAVE_RELOADS");
  const block = source.slice(source.indexOf("{") + 1);
  for (const otherDraft of [false, true]) {
    const snapshots = new Map();
    let reloads = 0;
    let recorded = false;
    const context = vm.createContext({
      key: "branding",
      body: { selfLabel: "Saved name" },
      sectionSnapshots: snapshots,
      updateSectionDirty: () => {
        recorded = snapshots.has("branding");
      },
      SAVE_ST: { branding: "st-branding" },
      setStatus() {},
      hasGovernanceDraft: () => otherDraft,
      location: {
        reload: () => {
          reloads++;
        },
      },
    });
    vm.runInContext(`(() => {${block}})()`, context);
    assert.equal(recorded, true);
    assert.equal(snapshots.get("branding"), JSON.stringify({ selfLabel: "Saved name" }));
    assert.equal(reloads, otherDraft ? 0 : 1);
  }
});

test("credential usage distinguishes loading, failure, and confirmed zero", () => {
  const context = vm.createContext({ plural: (n: number, word: string) => `${n} ${word}s`, fmtTime: String });
  vm.runInContext(extract("function serviceCredentialUsageLabel(", "function renderServiceCreds("), context);
  assert.equal(vm.runInContext("serviceCredentialUsageLabel({})", context), "Loading usage…");
  assert.equal(vm.runInContext("serviceCredentialUsageLabel({usageUnavailable:true})", context), "Usage unavailable");
  assert.equal(
    vm.runInContext("serviceCredentialUsageLabel({usageCount:0})", context),
    "0 successful uses in retained broker history",
  );
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
      extract("async function loadServiceCredentialUsage(", "function serviceCredentialUsageLabel("),
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
  const pending = Promise.withResolvers<unknown>();
  const messages: unknown[] = [];
  const add = { disabled: false };
  const context = vm.createContext({
    scope: "org:example",
    view: "credentials",
    governanceReq: 0,
    loadedGovernanceScope: null,
    serviceCredList: [{ slug: "stale" }],
    setServiceCredentialState: (...args: unknown[]) => messages.push(args),
    $: () => add,
    loadPersonalKeychainSummary() {},
    setStatus() {},
    api: () => pending.promise,
  });
  const source = extract("async function loadScope() {", "        const refreshModelChoices = [];");
  vm.runInContext(source + "}", context);
  const work = vm.runInContext("loadScope()", context);
  assert.deepEqual(messages, [["Loading credentials…"]]);
  assert.equal(add.disabled, true);
  assert.equal(context.serviceCredList.length, 0);
  pending.resolve({ ok: false, status: 500 });
  await work;
  assert.deepEqual(messages.at(-1), ["Could not load credentials.", true]);
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
