import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function source(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  disabled = false;
  checked = false;
  hidden = false;
  text = "";
  private selected = "";
  classes = new Set<string>();
  oninput?: () => void;
  onchange?: () => void;
  onclick?: () => Promise<void>;
  classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, on = !this.classes.has(name)) => {
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
  };
  readonly tagName: string;
  constructor(tagName = "DIV") {
    this.tagName = tagName;
  }
  get value() {
    return this.selected;
  }
  set value(value: string) {
    this.selected = this.tagName === "SELECT" && !this.children.some((o) => o.value === value) ? "" : value;
  }
  get textContent() {
    return this.text;
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
    if (this.tagName === "SELECT") this.selected = "";
  }
  get options() {
    return this.children;
  }
  get selectedOptions() {
    return this.children.filter((o) => o.value === this.value);
  }
  appendChild(child: Element) {
    this.children.push(child);
    if (this.tagName === "SELECT" && this.children.length === 1) this.selected = child.value;
    return child;
  }
  append(...children: Element[]) {
    children.forEach((child) => this.appendChild(child));
  }
  setAttribute(name: string, value: string) {
    this.dataset[name] = value;
  }
  remove() {}
  querySelectorAll(_selector: string): Element[] {
    return [];
  }
  querySelector(_selector: string): Element | null {
    return null;
  }
  closest(_selector: string): Element | null {
    return null;
  }
}
const model = (id: string) => ({ id, name: id, available: true });
function config(
  runtime: Record<string, unknown> | null = { harnessId: "pi", modelId: "alpha", effortLevel: "high", fastMode: true },
): any {
  return {
    scopeId: "channel:A",
    runtime,
    baseModel: runtime?.modelId ?? null,
    harnessDefault: "pi",
    baseModelDefault: "alpha",
    baseModelOptions: [model("alpha"), model("beta")],
    harnessOptions: ["pi", "codex"],
    approvedHarnesses: ["pi", "codex"],
    modelsByHarness: { pi: [model("alpha"), model("beta")], codex: [model("gpt-fixture")] },
    thinkingLevelsByHarness: { pi: ["auto", "low", "high"], codex: ["auto", "low", "high"] },
    fastModeHarnessIds: ["pi"],
    fastModeModelIds: ["alpha"],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ok = (data: any) => ({ ok: true, status: 200, data });
function harness() {
  const nodes = new Map<string, Element>();
  const $ = (id: string): Element => {
    if (!nodes.has(id))
      nodes.set(
        id,
        new Element(
          ["base-model", "base-harness", "base-effort"].includes(id) || id.endsWith("-add") ? "SELECT" : "DIV",
        ),
      );
    return nodes.get(id)!;
  };
  $("egress-capability").querySelector = (selector) => $("egress-capability-" + selector);
  const card = $("card-base-model");
  const button = new Element("BUTTON");
  button.dataset.save = "runtime";
  button.closest = () => card;
  card.querySelector = (selector) => (selector === "button.dirty" && !button.classes.has("dirty") ? null : button);
  card.querySelectorAll = () => [
    $("base-inherit"),
    $("base-harness"),
    $("base-model"),
    $("base-effort"),
    $("base-fast-mode"),
    button,
  ];
  const document = {
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    querySelectorAll: (selector: string) => (selector === "[data-save]" ? [button] : []),
    querySelector: (selector: string) => {
      if (selector === '[data-save="runtime"]') return button;
      return selector === '[data-save="egress"]' ? $("egress-save") : null;
    },
  };
  const calls: { method: string; path: string; body: any }[] = [];
  const statuses = new Map<string, string>();
  const overview = new Map<string, [string, string]>();
  const state = {
    data: config(),
    manifest: [{ id: "runtime", target: "any", clearable: true }],
    get: null as null | (() => Promise<any>),
    put: null as null | (() => Promise<any>),
    resources: null as null | (() => Promise<any>),
  };
  const context = vm.createContext({
    $,
    document,
    scope: "channel:A",
    view: "governance",
    loadedGovernanceScope: null,
    loadedCommandPolicyPresent: false,
    soulVersion: 0,
    soulSaved: "",
    soulHistory: [],
    serviceCredDirectory: [],
    governanceOrgAmbientSaved: "",
    webuiModelIds: [],
    ackEmojiNames: [],
    governanceOverviewData: {},
    titleCase: (s: string) => s,
    collectEgress: () => ({}),
    setGovernanceStatus: (id: string, value: string, detail: string) => overview.set(id, [value, detail]),
    setStatus: (id: string, message: string, kind: string) => {
      statuses.set(id, message);
      $(id).classes = new Set(["status", kind]);
    },
    governanceSaveReview: async () => true,
    api: async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body: body && JSON.parse(JSON.stringify(body)) });
      if (path === "/api/resources") return state.resources ? state.resources() : ok({ resources: state.manifest });
      if (method === "GET")
        return state.get ? state.get() : ok({ ...state.data, scopeId: decodeURIComponent(path.split("/").at(-1)!) });
      if (state.put) return state.put();
      if (body.inherit) state.data = { ...state.data, runtime: null, baseModel: null };
      else state.data = { ...state.data, runtime: { ...body }, baseModel: body.modelId };
      return ok({});
    },
  });
  for (const name of [
    "renderEnvironmentNotice",
    "syncGovernanceSectionNav",
    "renderPolicy",
    "updateSoulWorkbench",
    "renderSoulHistory",
    "renderAmbientPolicy",
    "populateEgress",
    "renderServiceCreds",
    "loadCustomProviders",
    "loadPersonalKeychainSummary",
    "resetScForm",
    "initCustomDropdowns",
  ])
    context[name] = () => {};
  vm.runInContext(
    source("      function setCardDirty(card, dirty, statusId, saveSelector)", "      function tableWrap(t)"),
    context,
  );
  vm.runInContext(
    source("      function renderGovernanceOverview(data)", "      function syncGovernanceSectionNav()"),
    context,
  );
  vm.runInContext(source("      let governanceReq = 0;", "      async function refreshSoulConflict()"), context);
  vm.runInContext(source("      const SAVE = {", "      function saveKeyForTarget(target)"), context);
  vm.runInContext(
    source("      let governanceSaveSeq = 0;", '      $("view-governance").addEventListener("input"'),
    context,
  );
  return {
    $,
    button,
    context,
    state,
    statuses,
    overview,
    calls,
    load: (scope = context.scope) => {
      context.scope = scope;
      return context.loadScope() as Promise<void>;
    },
    input: (id: string, value: string | boolean) => {
      const node = $(id);
      if (typeof value === "boolean") node.checked = value;
      else node.value = value;
      node.oninput?.();
      context.updateSectionDirty("runtime");
    },
    save: () => button.onclick!(),
    puts: () => calls.filter((call) => call.method === "PUT"),
  };
}

for (const scope of ["org:acme", "channel:A", "group:project-A", "personal:alice", "team:T1"]) {
  test(`runtime card loads and saves the exact ${scope} scope`, async () => {
    const h = harness();
    await h.load(scope);
    assert.equal(h.$("card-base-model").classes.has("hidden"), false);
    assert.equal(h.$("base-model").value, "alpha");
    assert.equal(h.$("base-effort").value, "high");
    h.input("base-model", "beta");
    await h.save();
    assert.equal(h.puts()[0]?.path, `/api/scopes/${encodeURIComponent(scope)}/runtime`);
    assert.equal(h.puts()[0]?.body.modelId, "beta");
    assert.equal(h.button.disabled, true);
    if (!scope.startsWith("org:")) assert.equal(h.$("card-webui-models").classes.has("hidden"), true);
  });
}
test("scope reload initializes model and effort from the response, never the prior form", async () => {
  const h = harness();
  await h.load("org:acme");
  h.state.data = config({ harnessId: "pi", modelId: "beta", effortLevel: "low" });
  await h.load("org:acme");
  assert.equal(h.$("base-model").value, "beta");
  assert.equal(h.$("base-effort").value, "low");
  await h.load("channel:B");
  assert.equal(h.$("base-model").value, "beta");
  assert.equal(h.$("base-effort").value, "low");
});
test("manifest applicability and clearability control only runtime", async () => {
  const h = harness();
  h.state.manifest[0]!.target = "org";
  await h.load();
  assert.equal(h.$("card-base-model").classes.has("hidden"), true);
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.puts().length, 0);
  await h.load("org:acme");
  assert.equal(h.$("card-base-model").classes.has("hidden"), false);
  h.state.manifest[0]!.target = "any";
  h.state.manifest[0]!.clearable = false;
  await h.load("channel:A");
  assert.equal(h.$("base-inherit-control").classes.has("hidden"), true);
});
test("inherited state is truthful and reset deletes the override rather than copying org values", async () => {
  const h = harness();
  h.state.data = config(null);
  await h.load();
  assert.equal(h.$("base-inherit").checked, true);
  assert.equal(h.$("base-runtime-fields").classes.has("hidden"), true);
  assert.match(h.overview.get("governance-status-model")!.join(" "), /[Ii]nherit.*organization/);
  assert.equal(h.button.disabled, true);
  h.input("base-inherit", false);
  assert.equal(h.button.disabled, true);
  h.input("base-harness", "pi");
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.state.data.runtime.modelId, "beta");
  h.input("base-inherit", true);
  await h.save();
  assert.deepEqual(h.puts().at(-1)!.body, { inherit: true });
  assert.equal(h.state.data.runtime, null);
  assert.equal(h.$("base-inherit").checked, true);
  h.state.data.baseModelDefault = "not-the-org-runtime";
  await h.load();
  assert.equal(h.$("base-inherit").checked, true);
  assert.equal(h.button.disabled, true);
});
test("legacy model-only rows are overrides and can be reset", async () => {
  const h = harness();
  h.state.data = { ...config(null), baseModel: "beta" };
  await h.load();
  assert.equal(h.$("base-inherit").checked, false);
  assert.equal(h.$("base-model").value, "beta");
  h.input("base-inherit", true);
  await h.save();
  assert.deepEqual(h.puts()[0]?.body, { inherit: true });
});
test("empty deployment catalog does not hide alternative or custom harness models", async () => {
  const h = harness();
  h.state.data = config({ harnessId: "codex", modelId: "gpt-fixture", effortLevel: "low" });
  h.state.data.baseModelOptions = [];
  h.state.data.modelsByHarness.pi = [];
  await h.load("org:acme");
  assert.equal(h.$("card-base-model").classes.has("hidden"), false);
  assert.equal(h.$("base-model").value, "gpt-fixture");
  h.state.data = config({ harnessId: "pi", modelId: "custom/deepseek" });
  h.state.data.modelsByHarness.pi.push(model("custom/deepseek"));
  await h.load();
  assert.equal(h.$("base-model").value, "custom/deepseek");
});
test("missing saved model, harness and effort stay visible without silently substituting", async () => {
  for (const missing of [{ modelId: "retired" }, { harnessId: "removed" }, { effortLevel: "retired-effort" }]) {
    const h = harness();
    h.state.data = config({ harnessId: "pi", modelId: "alpha", effortLevel: "high", ...missing });
    await h.load();
    for (const [key, value] of Object.entries(missing))
      assert.equal(
        h.$({ modelId: "base-model", harnessId: "base-harness", effortLevel: "base-effort" }[key]!).value,
        value,
      );
    h.input("base-fast-mode", false);
    await h.save();
    assert.equal(h.puts().length, 0);
    h.input("base-inherit", true);
    await h.save();
    assert.deepEqual(h.puts()[0]?.body, { inherit: true });
  }
});
test("empty catalogs allow reset but not an empty override", async () => {
  const h = harness();
  h.state.data.baseModelOptions = [];
  h.state.data.harnessOptions = [];
  h.state.data.modelsByHarness = {};
  await h.load();
  assert.equal(h.$("card-base-model").classes.has("hidden"), false);
  h.input("base-fast-mode", false);
  await h.save();
  assert.equal(h.puts().length, 0);
  h.input("base-inherit", true);
  await h.save();
  assert.deepEqual(h.puts()[0]?.body, { inherit: true });
});
test("harness changes retain compatible effort and normalize unsupported fast mode", async () => {
  const h = harness();
  await h.load();
  h.input("base-harness", "codex");
  assert.equal(h.$("base-model").value, "gpt-fixture");
  assert.equal(h.$("base-effort").value, "high");
  assert.equal(h.$("base-fast-mode").checked, false);
  assert.equal(h.$("base-fast-mode").disabled, true);
});
test("rapid switching and failed loads never permit writing the previous scope's form", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  const pending = deferred<any>();
  h.state.get = () => pending.promise;
  const loading = h.load("channel:B");
  const staleSave = h.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const staleWrites = h.puts().length;
  h.state.get = null;
  h.state.data = config({ harnessId: "pi", modelId: "beta", effortLevel: "low" });
  await h.load("channel:C");
  pending.resolve(ok({ ...config(), scopeId: "channel:B" }));
  await Promise.all([loading, staleSave]);
  assert.equal(staleWrites, 0);
  assert.equal(h.$("base-effort").value, "low");
  h.state.get = async () => ({ ok: false, status: 403, data: {} });
  await h.load("channel:D");
  h.input("base-model", "alpha");
  await h.save();
  assert.equal(h.puts().length, 0);
  assert.equal(h.button.disabled, true);
});
test("mismatched response and missing/failed manifest fail closed and recover on reload", async () => {
  const h = harness();
  h.state.get = async () => ok({ ...config(), scopeId: "channel:wrong" });
  await h.load();
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.puts().length, 0);
  h.state.get = null;
  for (const response of [{ ok: false, status: 502, data: {} }, ok({ resources: [] })]) {
    h.state.resources = async () => response;
    await h.load();
    h.input("base-model", "beta");
    await h.save();
    assert.equal(h.puts().length, 0);
  }
  h.state.resources = null;
  await h.load();
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.puts().length, 1);
});
test("delayed writes retain their target and cannot paint a newer scope or permit duplicate Apply", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  const pending = deferred<any>();
  h.state.put = () => pending.promise;
  const saving = h.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const duplicate = h.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const count = h.puts().length;
  await h.load("channel:B");
  pending.resolve(ok({}));
  await Promise.all([saving, duplicate]);
  assert.equal(count, 1);
  assert.equal(h.puts()[0]!.path, "/api/scopes/channel%3AA/runtime");
  assert.notEqual(h.statuses.get("st-runtime"), "Saved");
});
test("same-scope reload during a pending write rejects that write's stale UI completion", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  const pending = deferred<any>();
  h.state.put = () => pending.promise;
  const saving = h.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.state.data = config({ harnessId: "pi", modelId: "alpha", effortLevel: "low" });
  await h.load();
  pending.resolve(ok({}));
  await saving;
  assert.equal(h.$("base-effort").value, "low");
  assert.notEqual(h.statuses.get("st-runtime"), "Saved");
});
test("failed writes keep the draft and error; failed readback never claims Saved", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  h.state.put = async () => ({ ok: false, status: 400, data: { message: "not serviceable" } });
  await h.save();
  assert.equal(h.$("base-model").value, "beta");
  assert.equal(h.statuses.get("st-runtime"), "not serviceable");
  assert.equal(h.button.disabled, false);
  h.state.put = async () => {
    h.state.get = async () => ({ ok: false, status: 502, data: {} });
    return ok({});
  };
  await h.save();
  assert.notEqual(h.statuses.get("st-runtime"), "Saved");
  assert.equal(h.button.disabled, true);
});

test("an unloaded form and an A-B-A stale load cannot create an override", async () => {
  const h = harness();
  h.button.classList.add("dirty");
  await h.save();
  assert.equal(h.puts().length, 0);
  const old = deferred<any>();
  h.state.get = () => old.promise;
  const first = h.load("channel:A");
  h.state.get = null;
  await h.load("channel:B");
  h.state.data = config({ harnessId: "pi", modelId: "beta", effortLevel: "low" });
  await h.load("channel:A");
  old.resolve(ok({ ...config(), scopeId: "channel:A" }));
  await first;
  assert.equal(h.$("base-model").value, "beta");
  assert.equal(h.$("base-effort").value, "low");
  assert.equal(h.button.disabled, true);
});

test("a delayed manifest cannot reenable stale scope values and manifest failure is visible", async () => {
  const h = harness();
  await h.load();
  const manifest = deferred<any>();
  h.state.resources = () => manifest.promise;
  const pending = h.load("channel:B");
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.puts().length, 0);
  h.state.resources = async () => ({ ok: false, status: 503, data: {} });
  await h.load("channel:C");
  const error = h.statuses.get("st-runtime");
  assert.match(error!, /could not be loaded/);
  assert.equal(h.button.disabled, true);
  assert.equal(h.$("card-base-model").classes.has("hidden"), false);
  manifest.resolve(ok({ resources: h.state.manifest }));
  await pending;
  assert.equal(h.statuses.get("st-runtime"), error);
  assert.equal(h.button.disabled, true);
});

test("reload during confirmation cancels a captured draft even at the same scope", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  const review = deferred<boolean>();
  h.context.governanceSaveReview = () => review.promise;
  const saving = h.save();
  await h.load();
  review.resolve(true);
  await saving;
  assert.equal(h.puts().length, 0);
});

test("late write failure never replaces another scope's load error", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  const write = deferred<any>();
  h.state.put = () => write.promise;
  const saving = h.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.state.get = async () => ({ ok: false, status: 403, data: {} });
  await h.load("channel:B");
  const error = h.statuses.get("st-runtime");
  write.resolve({ ok: false, status: 400, data: { message: "old failure" } });
  await saving;
  assert.equal(h.statuses.get("st-runtime"), error);
  assert.equal(h.button.disabled, true);
});

test("authorization rejection remains visible without discarding the draft", async () => {
  const h = harness();
  await h.load();
  h.input("base-model", "beta");
  h.state.put = async () => ({ ok: false, status: 403, data: {} });
  await h.save();
  assert.equal(h.statuses.get("st-runtime"), "Not authorized for this scope.");
  assert.equal(h.$("base-model").value, "beta");
  assert.equal(h.button.disabled, false);
});

test("persisted unapproved harness remains unavailable even when retained by the API", async () => {
  const h = harness();
  h.state.data.approvedHarnesses = ["codex"];
  await h.load();
  assert.equal(h.$("base-harness").value, "pi");
  assert.equal(h.$("base-harness").selectedOptions[0]?.disabled, true);
  assert.match(h.$("base-harness").selectedOptions[0]!.textContent, /unavailable/);
  h.input("base-effort", "low");
  await h.save();
  assert.equal(h.puts().length, 0);
  h.input("base-harness", "codex");
  await h.save();
  assert.equal(h.puts()[0]?.body.harnessId, "codex");
  assert.equal(h.puts()[0]?.body.modelId, "gpt-fixture");
});

test("persisted unserviceable model is unavailable, resettable and recoverable", async () => {
  const h = harness();
  h.state.data.modelsByHarness.pi[0].available = false;
  await h.load();
  assert.equal(h.$("base-model").value, "alpha");
  assert.equal(h.$("base-model").selectedOptions[0]?.disabled, true);
  assert.match(h.$("base-model").selectedOptions[0]!.textContent, /unavailable/);
  h.input("base-effort", "low");
  await h.save();
  assert.equal(h.puts().length, 0);
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.puts()[0]?.body.modelId, "beta");
  h.state.data = config();
  h.state.data.modelsByHarness.pi[0].available = false;
  await h.load();
  h.input("base-inherit", true);
  await h.save();
  assert.deepEqual(h.puts().at(-1)?.body, { inherit: true });
});

test("default approval fallback does not bless a retained alternative harness", async () => {
  const h = harness();
  h.state.data = config({ harnessId: "codex", modelId: "gpt-fixture" });
  h.state.data.approvedHarnesses = null;
  await h.load();
  assert.equal(h.$("base-harness").selectedOptions[0]?.disabled, true);
  h.input("base-harness", "pi");
  await h.save();
  assert.equal(h.puts()[0]?.body.harnessId, "pi");
});

test("only the scoped Governance view can apply runtime and names its target", async () => {
  const h = harness();
  await h.load("team:T1");
  assert.equal(h.$("base-runtime-target").textContent, "Applies to team:T1");
  h.input("base-model", "beta");
  h.context.view = "models";
  await h.save();
  assert.equal(h.puts().length, 0);
  h.context.view = "governance";
  await h.load("team:T1");
  h.input("base-model", "beta");
  await h.save();
  assert.equal(h.puts()[0]?.path, "/api/scopes/team%3AT1/runtime");
});

test("harness changes skip a retained unavailable first model", async () => {
  const h = harness();
  h.state.data = config({ harnessId: "codex", modelId: "gpt-fixture" });
  h.state.data.modelsByHarness.pi[0].available = false;
  await h.load();
  h.input("base-harness", "pi");
  assert.equal(h.$("base-model").value, "beta");
  await h.save();
  assert.equal(h.puts()[0]?.body.modelId, "beta");
});
