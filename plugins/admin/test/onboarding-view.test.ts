import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return html.slice(start, end);
}

function resolveView(pathname: string, search: string): string {
  const src = [
    slice("const SECTIONS = [", "function prepareParityCards"),
    slice("const DEFAULT_VIEW = ", ";") + ";",
    slice("function decodePathSegment(seg) {", "let transcriptObserver"),
    "urlToState().view;",
  ].join("\n");
  const context = vm.createContext({
    URLSearchParams,
    API_BASE: "/admin",
    scope: "org",
    orgId: "acme",
    location: { pathname, search },
  });
  return vm.runInContext(src, context);
}

const bundle = buildSync({
  entryPoints: [new URL("../ui/onboarding.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "onboarding",
  platform: "browser",
}).outputFiles[0].text;
function fixture() {
  const dom = new JSDOM(
    '<template data-onboarding-ui="steps"></template><template data-onboarding-ui="provider"></template><template data-onboarding-ui="registry"></template>',
    { runScripts: "outside-only", url: "http://localhost/admin/onboarding" },
  );
  dom.window.eval(bundle + ";window.Onboarding = onboarding.Onboarding;");
  const controller = new (dom.window as any).Onboarding({
    api: async () => ({ ok: true, data: {} }),
    orgScope: () => "org:default-org",
    connectorName: (id: string) => id,
    view: () => "onboarding",
    loaded: () => {},
    loadCustomProviders: async () => {},
    navigate: () => {},
  });
  controller.mount();
  return { dom, controller };
}

async function runLoadOnboarding(
  modelProviders: unknown,
  scopeConfig: unknown = { baseModel: "claude-opus-5" },
): Promise<Record<string, any>> {
  const { dom, controller } = fixture();
  const fixtures: Record<string, unknown> = {
    "/api/model-providers?catalog=cached": modelProviders,
    "/api/slack-installation": { configured: false },
    "/api/connector-catalog": { catalog: [] },
    "/api/scopes/org%3Adefault-org?view=onboarding": scopeConfig,
  };
  controller.context.api = async (_method: string, path: string) => ({ ok: true, data: fixtures[path] ?? {} });
  await controller.load();
  const elements = Object.fromEntries(
    [...dom.window.document.querySelectorAll<HTMLElement>("[id]")].map((el) => [
      el.id,
      { textContent: el.textContent?.trim(), className: el.className, value: (el as HTMLInputElement).value },
    ]),
  );
  dom.window.close();
  return elements;
}

const UNCONFIGURED_PROVIDERS = [
  { provider: "anthropic", configured: false, source: "absent" },
  { provider: "openai", configured: false, source: "absent" },
  { provider: "openrouter", configured: false, source: "absent" },
];
const ANTHROPIC_MODELS = [
  { id: "first-option", name: "First model", provider: "anthropic" },
  { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
];

test("harness-carried auth shows the model step as ready without a stored key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
    harnessAuth: { harnessId: "claude", provider: "anthropic" },
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge ok");
  assert.equal(elements["onboarding-model-id"]!.value, "claude-opus-5");
  assert.equal(
    elements["onboarding-model-summary"]!.textContent,
    "claude-opus-5 · authenticated by the claude harness — no API key needed.",
  );
});

test("without harness auth an unconfigured provider still needs a key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Needs a key");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge warn");
  assert.match(elements["onboarding-model-summary"]!.textContent, /cannot run until its Anthropic key is configured/);
});

test("a stored key keeps its summary even when the harness also carries auth", async () => {
  const elements = await runLoadOnboarding({
    providers: [
      { provider: "anthropic", configured: true, source: "admin" },
      { provider: "openai", configured: false, source: "absent" },
      { provider: "openrouter", configured: false, source: "absent" },
    ],
    models: ANTHROPIC_MODELS,
    harnessAuth: { harnessId: "claude", provider: "anthropic" },
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-summary"]!.textContent, "claude-opus-5 · admin-managed key");
});

test("/admin/onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/onboarding", ""), "onboarding");
});

test("?view=onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/", "?view=onboarding"), "onboarding");
});

test("unknown views still fall back to the default view", () => {
  assert.equal(resolveView("/admin/no-such-view", ""), "history");
});

test("model registry verification makes charges and credential scope explicit", async () => {
  const { dom, controller } = fixture();
  const button = dom.window.document.querySelector<HTMLButtonElement>("#model-registry-save")!;
  assert.equal(button.disabled, true);
  const notice = dom.window.document.querySelector("#model-registry-verification-notice")!.textContent!;
  assert.match(notice, /provider charge/);
  assert.match(notice, /personal-key access/);
  controller.registryId = "known";
  controller.showLookup({
    kind: "builtin",
    spec: { name: "Known", id: "known", contextWindow: 1000, maxTokens: 100, cost: { input: 1, output: 2 } },
    source: "catalog",
    missing: [],
  });
  let complete: (response: unknown) => void = () => {};
  const calls: any[] = [];
  controller.context.api = (...args: any[]) => {
    calls.push(args);
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  controller.draw();
  const saving = controller.verify();
  assert.equal(button.disabled, true);
  assert.match(button.textContent!, /Verifying/);
  assert.equal(calls[0][0], "POST");
  assert.equal(calls[0][1], "/api/model-registry/known/enable");
  assert.equal(calls[0][2].verify, true);
  complete({ ok: false, data: { message: "Access denied" } });
  await saving;
  assert.equal(button.disabled, false);
  assert.match(dom.window.document.querySelector("#st-model-registry")!.textContent!, /Access denied/);
  dom.window.close();
});

test("model setup separates missing fields and discards stale lookups", async () => {
  const { dom, controller } = fixture();
  assert.equal(dom.window.document.querySelector<HTMLDivElement>("#model-registry-result")!.hidden, true);
  controller.registryId = "first";
  let complete: (response: unknown) => void = () => {};
  controller.context.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const pending = controller.lookupModel();
  const input = dom.window.document.querySelector<HTMLInputElement>("#model-registry-id")!;
  input.value = "second";
  input.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true, data: { spec: { id: "first" }, source: "catalog" } });
  await pending;
  assert.equal(controller.lookup, null);
  controller.showLookup({
    kind: "custom",
    spec: { id: "second", name: "Second", cost: {} },
    source: "provider",
    missing: ["template", "contextWindow"],
  });
  controller.draw();
  assert.ok(dom.window.document.querySelector("#model-registry-missing-fields #model-registry-template"));
  assert.ok(dom.window.document.querySelector("#model-registry-advanced-fields #model-registry-name"));
  assert.equal(dom.window.document.querySelector<HTMLInputElement>("#model-registry-name")!.value, "Second");
  controller.registryId = "third";
  assert.throws(() => controller.collect(), /current model/);
  dom.window.close();
});

test("cold catalog preserves the configured dynamic model and its provider", async () => {
  const model = { id: "future/configured-model", name: "Configured model", provider: "openrouter" };
  const elements = await runLoadOnboarding(
    { providers: UNCONFIGURED_PROVIDERS.map((p) => ({ ...p, configured: true })), models: ANTHROPIC_MODELS },
    { baseModel: model.id, baseModelOptions: [model] },
  );
  assert.equal(elements["onboarding-model-provider"].value, "openrouter");
  assert.equal(elements["onboarding-model-id"].value, model.id);
});

test("upfront Slack links select Slack settings before launching, including completion", () => {
  for (const step of ["setup", "install", "connected"])
    assert.equal(resolveView("/admin", `?slack=${step}`), "slack-settings");
  assert.equal(resolveView("/admin", "?slack=unknown"), "history");
});

test("pending onboarding reads preserve the provider associated with a newly entered key", async () => {
  const { dom, controller } = fixture();
  let complete: (response: unknown) => void = () => {};
  controller.context.api = async (_method: string, path: string) => {
    if (path === "/api/model-providers?catalog=cached")
      return new Promise((resolve) => {
        complete = resolve;
      });
    if (path.includes("?view=onboarding")) return { ok: true, data: { baseModel: "claude-opus-5" } };
    return { ok: true, data: {} };
  };
  const pending = controller.load();
  const select = dom.window.document.querySelector<HTMLSelectElement>("#onboarding-model-provider")!;
  select.value = "openai";
  select.dispatchEvent(new dom.window.Event("change"));
  const key = dom.window.document.querySelector<HTMLInputElement>("#onboarding-model-key")!;
  key.value = "test-only-key";
  key.dispatchEvent(new dom.window.Event("input"));
  complete({
    ok: true,
    data: {
      providers: UNCONFIGURED_PROVIDERS,
      models: [...ANTHROPIC_MODELS, { id: "gpt-test", name: "GPT test", provider: "openai" }],
    },
  });
  await pending;
  assert.equal(controller.provider, "openai");
  assert.equal(controller.model, "gpt-test");
  assert.equal(select.value, "openai");
  assert.equal(key.value, "test-only-key");
  dom.window.close();
});
