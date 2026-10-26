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
    '<template data-onboarding-ui="steps"></template><template data-onboarding-ui="provider"></template>',
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

test("subscription auth shows the model step as ready without a stored key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
    subscriptionAuth: { provider: "anthropic" },
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge ok");
  assert.equal(elements["onboarding-model-id"]!.value, "claude-opus-5");
  assert.equal(
    elements["onboarding-model-summary"]!.textContent,
    "claude-opus-5 · authenticated by subscription — no API key needed.",
  );
});

test("without subscription auth an unconfigured provider still needs a key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Needs a key");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge warn");
  assert.match(elements["onboarding-model-summary"]!.textContent, /cannot run until its Anthropic key is configured/);
});

test("a stored key keeps its summary even when a subscription also carries auth", async () => {
  const elements = await runLoadOnboarding({
    providers: [
      { provider: "anthropic", configured: true, source: "admin" },
      { provider: "openai", configured: false, source: "absent" },
      { provider: "openrouter", configured: false, source: "absent" },
    ],
    models: ANTHROPIC_MODELS,
    subscriptionAuth: { provider: "anthropic" },
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

test("saving another provider's key can keep the current base model", async () => {
  const { dom, controller } = fixture();
  const calls: string[] = [];
  controller.context.api = async (method: string, path: string) => {
    calls.push(method + " " + path);
    if (path.startsWith("/api/model-providers"))
      return {
        ok: true,
        data: {
          providers: UNCONFIGURED_PROVIDERS,
          models: [...ANTHROPIC_MODELS, { id: "gpt-test", name: "GPT test", provider: "openai" }],
        },
      };
    if (path.includes("?view=onboarding")) return { ok: true, data: { baseModel: "first-option" } };
    return { ok: true, data: {} };
  };
  await controller.load();
  const provider = dom.window.document.querySelector<HTMLSelectElement>("#onboarding-model-provider")!;
  provider.value = "openai";
  provider.dispatchEvent(new dom.window.Event("change"));
  const model = dom.window.document.querySelector<HTMLSelectElement>("#onboarding-model-id")!;
  assert.equal(model.options[model.options.length - 1]!.textContent, "Keep current base model (first-option)");
  assert.equal(model.value, "gpt-test");
  model.value = "";
  model.dispatchEvent(new dom.window.Event("change"));
  controller.apiKey = "sk-test";
  calls.length = 0;
  await controller.connect();
  assert.ok(calls.includes("PUT /api/model-providers/openai"));
  assert.ok(!calls.some((call) => call.endsWith("/base-model")));
  assert.match(controller.providerMessage, /base model is unchanged/);
  dom.window.close();
});

test("a rejected base model change shows the server's reason", async () => {
  const { dom, controller } = fixture();
  controller.context.api = async (method: string, path: string) => {
    if (method === "PUT" && path.endsWith("/base-model"))
      return { ok: false, data: { message: "model_not_supported" } };
    if (path.startsWith("/api/model-providers"))
      return { ok: true, data: { providers: UNCONFIGURED_PROVIDERS, models: ANTHROPIC_MODELS } };
    return { ok: true, data: {} };
  };
  await controller.load();
  controller.apiKey = "sk-test";
  controller.model = ANTHROPIC_MODELS[0]!.id;
  await controller.connect();
  assert.equal(controller.providerMessage, "Key saved, but the base model could not be changed: model_not_supported");
  assert.equal(controller.providerTone, "err");
  dom.window.close();
});

test("a pending onboarding load keeps an explicit keep-current-base-model choice", async () => {
  const { dom, controller } = fixture();
  let complete: (response: unknown) => void = () => {};
  controller.baseModel = "first-option";
  controller.models = {
    anthropic: ANTHROPIC_MODELS,
    openai: [{ id: "gpt-test", name: "GPT test", provider: "openai" }],
  };
  controller.context.api = async (_method: string, path: string) => {
    if (path === "/api/model-providers?catalog=cached")
      return new Promise((resolve) => {
        complete = resolve;
      });
    if (path.includes("?view=onboarding")) return { ok: true, data: { baseModel: "first-option" } };
    return { ok: true, data: {} };
  };
  const pending = controller.load();
  const provider = dom.window.document.querySelector<HTMLSelectElement>("#onboarding-model-provider")!;
  provider.value = "openai";
  provider.dispatchEvent(new dom.window.Event("change"));
  const model = dom.window.document.querySelector<HTMLSelectElement>("#onboarding-model-id")!;
  model.value = "";
  model.dispatchEvent(new dom.window.Event("change"));
  complete({
    ok: true,
    data: {
      providers: UNCONFIGURED_PROVIDERS,
      models: [...ANTHROPIC_MODELS, { id: "gpt-test", name: "GPT test", provider: "openai" }],
    },
  });
  await pending;
  assert.equal(controller.model, "");
  dom.window.close();
});
