import { load, states } from "../ui/governance-state.ts";
import assert from "node:assert/strict";
import { readAdminSource } from "./admin-source.ts";
import test from "node:test";
import vm from "node:vm";

const html = readAdminSource();

test("org governance exposes the Auto quarantine rubric and replay controls", () => {
  assert.ok(html.includes('id="card-auto-flagger"'), "Auto flagger editor must exist");
  assert.match(html, /id="card-auto-flagger"/);
  for (const id of [
    "auto-flagger-harness",
    "auto-flagger-model",
    "auto-flagger-rubric",
    "auto-flagger-test",
    "auto-flagger-window",
    "auto-flagger-compare",
    "auto-flagger-reset",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `${id} must exist`);
  }

  assert.match(html, /governanceUI.collect\(key\)/);
  assert.match(html, /"auto-flagger": "st-auto-flagger"/);
  assert.match(html, /function autoFlaggerTestSummary\(data\)/);
});

function slice(from: string, to: string) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return html.slice(start, end);
}

class Element {
  tag: string;
  constructor(tag = "select") {
    this.tag = tag;
  }
  value = "";
  hidden = false;
  disabled = false;
  checked = false;
  text = "";
  options: Element[] = [];
  classes = new Set<string>();
  classList = {
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  oninput?: () => void;
  onclick?: () => Promise<unknown>;
  set textContent(value: string) {
    this.text = value;
    this.options = [];
    if (this.tag === "select") this.value = "";
  }
  get textContent() {
    return this.text;
  }
  appendChild(option: Element) {
    this.options.push(option);
  }
}

function fixture(data: Record<string, unknown> = {}, scope = "org:example") {
  const elements: Record<string, Element> = {};
  const context = vm.createContext({
    governanceReq: 1,
    governanceUI: { collect: () => ({ harnessId: "pi", modelId: "model-a", rubric: "Default rubric" }) },
    refreshModelChoices: [],
    scope,
    scopeChanged: true,
    r: { data },
    $: (id: string) => (elements[id] ??= new Element()),
    document: { createElement: (tag: string) => new Element(tag) },
    plural: (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`,
    setStatus: (id: string, text: string) => ((elements[id] ??= new Element()).textContent = text),
  });
  return { elements, context };
}

const defaults = { harnessId: "pi", modelId: "model-a", rubric: "Default rubric" };
const loadData = {
  autoFlagger: null,
  autoFlaggerDefault: defaults,
  harnessOptions: ["pi", "claude"],
  modelsByHarness: {
    pi: [
      { id: "model-a", name: "A" },
      { id: "model-b", name: "B" },
    ],
    claude: [{ id: "model-c", name: "C" }],
  },
};

const handlersSource = slice('$("auto-flagger-test").onclick =', 'document.querySelectorAll("[data-save]").forEach');
const summarySource = slice("function autoFlaggerTestSummary(data)", "function sectionButton(key)");

test("loading defaults replaces a previous model and harness selection", () => {
  load(loadData, "org:example");
  const state = states.get("auto-flagger")!;
  state.change("auto-flagger-model", "model-b");
  load(loadData, "org:example");
  assert.equal(state.draft.modelId, "model-a");
  state.change("auto-flagger-harness", "claude");
  assert.equal(state.draft.modelId, "model-c");
});
test("unavailable configured flagger stays selectable", () => {
  load({ ...loadData, autoFlagger: { harnessId: "codex", modelId: "saved-model", rubric: "Saved" } }, "org:example");
  const state = states.get("auto-flagger")!;
  assert.equal(state.draft.modelId, "saved-model");
  assert.ok(state.models.some((model) => model.id === "saved-model"));
});
test("flagger is visible only for org payloads that support it", () => {
  load(loadData, "personal:example");
  assert.equal(states.get("auto-flagger")!.available, false);
  load({}, "org:example");
  assert.equal(states.get("auto-flagger")!.available, false);
});

test("test sends an unsaved draft and comparison window without saving it", async () => {
  const { elements, context } = fixture(loadData);
  vm.runInContext(`${summarySource}\n${handlersSource}`, context);
  elements["auto-flagger-harness"] = new Element();
  elements["auto-flagger-harness"].value = "pi";
  elements["auto-flagger-model"] = new Element();
  elements["auto-flagger-model"].value = "model-a";
  elements["auto-flagger-rubric"] = new Element();
  elements["auto-flagger-window"] = new Element();
  elements["auto-flagger-window"].value = "25";
  elements["auto-flagger-compare"] = new Element();
  elements["auto-flagger-compare"].checked = true;
  elements["auto-flagger-rubric"].value = "Unsaved draft — café";
  const calls: unknown[][] = [];
  context.api = async (...args: unknown[]) => {
    calls.push(args);
    return { ok: true, data: { sampled: 2, scored: 2, flagged: 1, flagRate: 0.5, durationMs: 100 } };
  };
  await elements["auto-flagger-test"].onclick!();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [
      "POST",
      "/api/scopes/org%3Aexample/auto-flagger/test",
      {
        window: 25,
        compare: true,
        harnessId: "pi",
        modelId: "model-a",
        rubric: "Unsaved draft — café",
      },
    ],
  ]);
  assert.match(elements["st-auto-flagger-test"].textContent, /Flagged 1 of 2 scored \(50.0%\)/);
  assert.equal(elements["auto-flagger-test"].disabled, false);
  elements["auto-flagger-window"].value = "0";
  await elements["auto-flagger-test"].onclick!();
  assert.equal(calls.length, 1);
  assert.equal(elements["auto-flagger-test-result"].hidden, false);
  assert.match(elements["st-auto-flagger-test"].textContent, /between 1 and 500/);
});

test("reset clears the override and does not reload a different scope after navigation", async () => {
  const { elements, context } = fixture(loadData);
  vm.runInContext(handlersSource, context);
  let reloads = 0;
  context.refreshPolicySetting = async (
    _key: string,
    _scope: string,
    _generation: number,
    _draft: string,
    message: string,
  ) => {
    reloads++;
    (elements["st-auto-flagger"] ??= new Element()).textContent = message;
  };
  context.api = async (method: string, path: string, body: unknown) => {
    assert.equal(method, "PUT");
    assert.equal(path, "/api/scopes/org%3Aexample/auto-flagger");
    assert.equal(JSON.stringify(body), '{"reset":true}');
    return { ok: true };
  };
  await elements["auto-flagger-reset"].onclick!();
  assert.equal(reloads, 1);
  assert.equal(elements["st-auto-flagger"].textContent, "Default restored");
  context.api = async () => {
    context.scope = "personal:other";
    return { ok: true };
  };
  await elements["auto-flagger-reset"].onclick!();
  assert.equal(reloads, 1);
});

test("replay summaries surface empty, partial, errored, and comparison results", () => {
  const { context } = fixture();
  vm.runInContext(summarySource, context);
  assert.match(vm.runInContext("autoFlaggerTestSummary({sampled: 0})", context), /No past screenings/);
  const summary = vm.runInContext(
    "autoFlaggerTestSummary({sampled:4,scored:2,flagged:1,flagRate:0.5,errors:1,unscreened:1,partial:true,durationMs:100,baseline:{flagRate:0,changed:1}})",
    context,
  );
  assert.match(summary, /current rubric flags 0.0%.*1 verdict changed/);
  assert.match(summary, /1 sample came back unscreened/);
  assert.match(summary, /1 sample errored/);
  assert.match(summary, /partial result/);
});
