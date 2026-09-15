import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return html.slice(start, end);
}

interface Model {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function loadParseFormat(): {
  parseCustomModels: (text: string) => Model[];
  formatCustomModelLine: (m: Model) => string;
} {
  const src = slice("let customProvidersLoaded = [];", "function closeCustomProviderEditor()");
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(
    src + "\nthis.parseCustomModels = parseCustomModels; this.formatCustomModelLine = formatCustomModelLine;",
    context,
  );
  return context as unknown as {
    parseCustomModels: (text: string) => Model[];
    formatCustomModelLine: (m: Model) => string;
  };
}

interface FakeElement {
  textContent: string;
  className: string;
  value: string;
  disabled: boolean;
  checked: boolean;
  focus(): void;
  showModal(): void;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadEditorAndSave() {
  const src = [
    slice("let customProvidersLoaded = [];", '$("custom-provider-cancel").onclick'),
    slice('$("custom-provider-save").onclick = async () => {', "function openOnboardingTarget"),
  ].join("\n");
  const elements: Record<string, FakeElement> = {};
  const statuses: Array<{ id: string; message: string; kind: string }> = [];
  const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];
  const context = vm.createContext({
    $: (id: string) =>
      (elements[id] ??= {
        textContent: "",
        className: "",
        value: "",
        disabled: false,
        checked: false,
        focus() {},
        showModal() {},
      }),
    api: async (method: string, path: string, body: unknown) => {
      apiCalls.push({ method, path, body });
      return { ok: true, data: {} };
    },
    setStatus: (id: string, message: string, kind: string) => {
      statuses.push({ id, message, kind });
    },
    view: "models",
    loadScope: async () => {},
    loadCustomProviders: async () => {},
    encodeURIComponent,
  });
  vm.runInContext(src, context);
  return { context, elements, statuses, apiCalls };
}

test("parses id/name/context/maxTokens and all four price fields", () => {
  const { parseCustomModels } = loadParseFormat();
  const models = plain(parseCustomModels("deepseek-chat | DeepSeek V3.2 | 128000 | 8192 | 0.28 | 1.42 | 0.028 | 0"));
  assert.deepEqual(models, [
    {
      id: "deepseek-chat",
      name: "DeepSeek V3.2",
      contextWindow: 128000,
      maxTokens: 8192,
      input: 0.28,
      output: 1.42,
      cacheRead: 0.028,
      cacheWrite: 0,
    },
  ]);
});

test("blank price fields stay undefined, never default to 0", () => {
  const { parseCustomModels } = loadParseFormat();
  const models = plain(parseCustomModels("bare-model"));
  assert.deepEqual(models, [{ id: "bare-model" }]);
  assert.equal("input" in models[0]!, false);
  assert.equal("cacheWrite" in models[0]!, false);
});

test("an explicit 0 price is distinct from a blank one", () => {
  const { parseCustomModels } = loadParseFormat();
  const models = parseCustomModels("m1 |  |  |  | 0 |  | 0 | ");
  assert.equal(models[0]!.input, 0);
  assert.equal("output" in models[0]!, false);
  assert.equal(models[0]!.cacheRead, 0);
  assert.equal("cacheWrite" in models[0]!, false);
});

test("round trip preserves blank vs zero and interior positions through format+parse", () => {
  const { parseCustomModels, formatCustomModelLine } = loadParseFormat();
  const original: Model = { id: "m1", contextWindow: 128000, input: 0, cacheWrite: 0.5 };
  const line = formatCustomModelLine(original);
  const [reparsed] = plain(parseCustomModels(line));
  assert.deepEqual(reparsed, original);
});

test("negative, NaN, and infinite prices are rejected with an actionable message", () => {
  const { parseCustomModels } = loadParseFormat();
  assert.throws(() => parseCustomModels("m1 | | | | -1"), /m1.*input.*non-negative/);
  assert.throws(() => parseCustomModels("m1 | | | | abc"), /m1.*input.*non-negative/);
  assert.throws(() => parseCustomModels("m1 | | | | Infinity"), /m1.*input.*non-negative/);
  assert.throws(() => parseCustomModels("m1 | | | | | | | NaN"), /m1.*cacheWrite.*non-negative/);
});

test("every line still requires a model id", () => {
  const { parseCustomModels } = loadParseFormat();
  assert.throws(() => parseCustomModels(" | name | 1 | 2"), /needs an id/);
});

test("editing a provider repopulates all four price fields and preserves other config", () => {
  const { context, elements } = loadEditorAndSave();
  const openCustomProviderEditor = (context as unknown as { openCustomProviderEditor: (p: unknown) => void })
    .openCustomProviderEditor;
  const provider = {
    id: "litellm",
    name: "LiteLLM",
    protocol: "openai",
    baseUrl: "https://gateway.internal/v1",
    models: [
      { id: "m1", name: "Model One", contextWindow: 64000, maxTokens: 4096, input: 1.5, output: 0, cacheRead: 0.15 },
      { id: "m2" },
    ],
  };
  openCustomProviderEditor(provider);
  assert.equal(elements["custom-provider-name"]!.value, "LiteLLM");
  assert.equal(elements["custom-provider-url"]!.value, "https://gateway.internal/v1");
  assert.equal(elements["custom-provider-models"]!.value, "m1 | Model One | 64000 | 4096 | 1.5 | 0 | 0.15\nm2");
});

test("save surfaces an invalid price as an actionable status instead of throwing uncaught", async () => {
  const { context, elements, statuses, apiCalls } = loadEditorAndSave();
  elements["custom-provider-id"] = {
    textContent: "",
    className: "",
    value: "litellm",
    disabled: false,
    checked: false,
    focus() {},
    showModal() {},
  };
  elements["custom-provider-name"] = { ...elements["custom-provider-id"]!, value: "LiteLLM" };
  elements["custom-provider-url"] = { ...elements["custom-provider-id"]!, value: "https://gateway.internal/v1" };
  elements["custom-provider-key"] = { ...elements["custom-provider-id"]!, value: "" };
  elements["custom-provider-protocol"] = { ...elements["custom-provider-id"]!, value: "openai" };
  elements["custom-provider-validate"] = { ...elements["custom-provider-id"]!, value: "", checked: true };
  elements["custom-provider-models"] = {
    ...elements["custom-provider-id"]!,
    value: "m1 | Model One | | | not-a-number",
  };
  const onclick = (context as unknown as { $(id: string): { onclick: () => Promise<void> } }).$(
    "custom-provider-save",
  ).onclick;
  await onclick();
  assert.equal(apiCalls.length, 0);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]!.kind, "err");
  assert.match(statuses[0]!.message, /m1.*input.*non-negative/);
});

test("save sends well-formed pricing through to the API on a valid submission", async () => {
  const { context, elements, apiCalls } = loadEditorAndSave();
  elements["custom-provider-id"] = {
    textContent: "",
    className: "",
    value: "litellm",
    disabled: false,
    checked: false,
    focus() {},
    showModal() {},
  };
  elements["custom-provider-name"] = { ...elements["custom-provider-id"]!, value: "LiteLLM" };
  elements["custom-provider-url"] = { ...elements["custom-provider-id"]!, value: "https://gateway.internal/v1" };
  elements["custom-provider-key"] = { ...elements["custom-provider-id"]!, value: "" };
  elements["custom-provider-protocol"] = { ...elements["custom-provider-id"]!, value: "openai" };
  elements["custom-provider-validate"] = { ...elements["custom-provider-id"]!, value: "", checked: true };
  elements["custom-provider-models"] = {
    ...elements["custom-provider-id"]!,
    value: "m1 | Model One | 64000 | 4096 | 1.5 | 3 | 0.15 | 0",
  };
  const onclick = (context as unknown as { $(id: string): { onclick: () => Promise<void> } }).$(
    "custom-provider-save",
  ).onclick;
  await onclick();
  assert.equal(apiCalls.length, 1);
  const body = plain(apiCalls[0]!.body) as { models: Model[] };
  assert.deepEqual(body.models, [
    {
      id: "m1",
      name: "Model One",
      contextWindow: 64000,
      maxTokens: 4096,
      input: 1.5,
      output: 3,
      cacheRead: 0.15,
      cacheWrite: 0,
    },
  ]);
});

test("the dialog documents USD-per-million-token pricing and cache read/write meaning", () => {
  const label = slice('<label class="custom-provider-models"', "</textarea>");
  assert.match(label, /input \$\/M \| output \$\/M \| cache read \$\/M \| cache write/);
  assert.match(label, /USD per million tokens/);
  assert.match(label, /cache read\/write price cached-token reuse/i);
  assert.match(label, /Leave a price blank when unknown/);
  assert.match(label, /stays unpriced/);
});
