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
