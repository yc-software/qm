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

function resolveView(pathname: string, search: string): string {
  const src = [
    slice("const SECTIONS = [", "const DISABLED_VIEWS"),
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

interface FakeElement {
  textContent: string;
  className: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  hidden: boolean;
  href: string;
  options: Array<{ value?: string; textContent?: string }>;
  appendChild(option: { value?: string; textContent?: string }): void;
}

async function runLoadOnboarding(
  modelProviders: unknown,
  scopeConfig: unknown = { baseModel: "claude-opus-5" },
): Promise<Record<string, FakeElement>> {
  const src = slice("let onboardingModels = {};", '$("onboarding-model-provider").onchange') + "\nloadOnboarding();";
  const elements: Record<string, FakeElement> = {};
  const fixtures: Record<string, unknown> = {
    "/api/model-providers?catalog=cached": modelProviders,
    "/api/slack-installation": { configured: false },
    "/api/connector-catalog": { catalog: [] },
    "/api/scopes/org%3Adefault-org?view=onboarding": scopeConfig,
  };
  const context = vm.createContext({
    $: (id: string) =>
      (elements[id] ??= {
        textContent: "",
        className: "",
        value: "",
        placeholder: "",
        disabled: false,
        hidden: false,
        href: "",
        options: [],
        appendChild(option) {
          this.options.push(option);
        },
      }),
    api: async (_method: string, path: string) => ({ ok: true, data: fixtures[path] ?? {} }),
    loadModelRegistry: async () => {},
    loadCustomProviders: async () => {},
    orgScope: () => "org:default-org",
    encodeURIComponent,
    setStatus: () => {},
    connectorName: (id: string) => id,
    viewLoadedAt: {},
    view: "onboarding",
    Date,
    document: { createElement: () => ({}) },
  });
  await vm.runInContext(src, context);
  return elements;
}

const UNCONFIGURED_PROVIDERS = [
  { provider: "anthropic", configured: false, source: "absent" },
  { provider: "openai", configured: false, source: "absent" },
  { provider: "openrouter", configured: false, source: "absent" },
];
const ANTHROPIC_MODELS = [{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" }];

test("harness-carried auth shows the model step as ready without a stored key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
    harnessAuth: { harnessId: "claude", provider: "anthropic" },
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge ok");
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

test("model registry verification makes charges and credential scope explicit", () => {
  assert.match(html, /id="model-registry-save" disabled>Verify and enable/);
  const notice = slice('id="model-registry-verification-notice"', "</p>");
  assert.match(notice, /provider charge/);
  assert.match(notice, /personal-key access/);
  const save = slice('$("model-registry-save").onclick', "let customProvidersLoaded");
  assert.match(save, /verify: true/);
  assert.match(save, /el.disabled = true/);
  assert.match(save, /Verifying…/);
  assert.match(save, /finally/);
  assert.match(save, /el.disabled = disabled/);
  assert.match(html, /Verified with organization credentials/);
});

test("model setup starts with two inputs, separates missing fields and discards stale lookups", () => {
  const form = slice(
    '<label\n                  >Provider\n                  <select id="model-registry-provider">',
    'id="model-registry-result"',
  );
  assert.match(form, /model-registry-id/);
  assert.doesNotMatch(form, /model-registry-contextWindow|model-registry-input/);
  assert.match(html, /<summary>Advanced overrides<\/summary>/);
  assert.match(html, /id="model-registry-missing-fields"/);
  const code = slice("let modelRegistryTemplates = []", "let customProvidersLoaded");
  assert.match(code, /request !== modelRegistryLookupRequest/);
  assert.match(code, /\$\("model-registry-id"\)\.oninput = resetRegistryLookup/);
  assert.match(code, /JSON\.stringify\(identity\) !== JSON\.stringify\(lookup.identity\)/);
  assert.match(code, /Choose a compatible template/);
  assert.match(code, /source/);
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

const CUSTOM_PROVIDERS_FIXTURE = [
  { provider: "anthropic", configured: false, source: "absent" },
  { provider: "acme-gateway", configured: true, source: "admin", custom: true },
];
const CUSTOM_MODELS_FIXTURE = [{ id: "acme-large", name: "Acme Large", provider: "acme-gateway" }];

test("a custom-provider base model hides built-in key controls and offers a manage action", async () => {
  const elements = await runLoadOnboarding(
    { providers: CUSTOM_PROVIDERS_FIXTURE, models: CUSTOM_MODELS_FIXTURE },
    { baseModel: "acme-large" },
  );
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-save"]!.hidden, true);
  assert.equal(elements["onboarding-model-delete"]!.hidden, true);
  assert.equal(elements["onboarding-model-manage-custom"]!.hidden, false);
  assert.equal(elements["onboarding-model-key"]!.disabled, true);
  assert.match(
    elements["onboarding-model-provider"]!.options.find((o) => o.value === "acme-gateway")!.textContent!,
    /\(custom\)/,
  );
});

test("a built-in provider keeps its key controls visible and enabled", async () => {
  const elements = await runLoadOnboarding({ providers: UNCONFIGURED_PROVIDERS, models: ANTHROPIC_MODELS });
  assert.equal(elements["onboarding-model-save"]!.hidden, false);
  assert.equal(elements["onboarding-model-delete"]!.hidden, false);
  assert.equal(elements["onboarding-model-manage-custom"]!.hidden, true);
  assert.equal(elements["onboarding-model-key"]!.disabled, false);
});

interface ControlsResult {
  elements: Record<string, FakeElement>;
  apiCalls: Array<{ method: string; path: string; body?: unknown }>;
  manageEditorCalls: unknown[];
}

async function runOnboardingModelControls(
  modelProviders: unknown,
  scopeConfig: unknown,
  customProvidersList: unknown[],
): Promise<ControlsResult> {
  const src = slice("let onboardingModels = {};", "let modelRegistryTemplates = [];") + "\nloadOnboarding();";
  const elements: Record<string, FakeElement> = {};
  const apiCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  const manageEditorCalls: unknown[] = [];
  const fixtures: Record<string, unknown> = {
    "/api/model-providers?catalog=cached": modelProviders,
    "/api/model-providers": modelProviders,
    "/api/slack-installation": { configured: false },
    "/api/connector-catalog": { catalog: [] },
    "/api/scopes/org%3Adefault-org?view=onboarding": scopeConfig,
    "/api/custom-providers": { providers: customProvidersList },
  };
  const context = vm.createContext({
    $: (id: string) =>
      (elements[id] ??= {
        textContent: "",
        className: "",
        value: "",
        placeholder: "",
        disabled: false,
        hidden: false,
        href: "",
        options: [],
        appendChild(option) {
          this.options.push(option);
        },
      }),
    api: async (method: string, path: string, body?: unknown) => {
      apiCalls.push({ method, path, body });
      return { ok: true, data: fixtures[path] ?? {} };
    },
    loadModelRegistry: async () => {},
    loadCustomProviders: async () => {},
    openCustomProviderEditor: (provider: unknown) => {
      manageEditorCalls.push(provider);
    },
    orgScope: () => "org:default-org",
    encodeURIComponent,
    setStatus: () => {},
    connectorName: (id: string) => id,
    confirm: () => true,
    viewLoadedAt: {},
    view: "onboarding",
    Date,
    document: { createElement: () => ({}) },
    customProvidersLoaded: customProvidersList,
  });
  await vm.runInContext(src, context);
  return { elements, apiCalls, manageEditorCalls };
}

test("saving or deleting a selected custom provider never calls the strict built-in routes", async () => {
  const { elements, apiCalls } = await runOnboardingModelControls(
    { providers: CUSTOM_PROVIDERS_FIXTURE, models: CUSTOM_MODELS_FIXTURE },
    { baseModel: "acme-large" },
    [{ id: "acme-gateway", name: "Acme Gateway", disabled: false, hasKey: true, models: CUSTOM_MODELS_FIXTURE }],
  );
  assert.equal(elements["onboarding-model-provider"]!.value, "acme-gateway");

  elements["onboarding-model-key"]!.value = "sk-should-be-ignored";
  await context_onclick(elements, "onboarding-model-save");
  await context_onclick(elements, "onboarding-model-delete");

  assert.ok(
    !apiCalls.some((call) => /\/api\/model-providers\/acme-gateway/.test(call.path)),
    `expected no built-in-route call for a custom provider, got: ${JSON.stringify(apiCalls)}`,
  );
});

test("the manage-custom-provider action opens the real custom-provider editor", async () => {
  const acme = {
    id: "acme-gateway",
    name: "Acme Gateway",
    disabled: false,
    hasKey: true,
    models: CUSTOM_MODELS_FIXTURE,
  };
  const { elements, manageEditorCalls } = await runOnboardingModelControls(
    { providers: CUSTOM_PROVIDERS_FIXTURE, models: CUSTOM_MODELS_FIXTURE },
    { baseModel: "acme-large" },
    [acme],
  );
  await context_onclick(elements, "onboarding-model-manage-custom");
  assert.deepEqual(manageEditorCalls, [acme]);
});

async function context_onclick(elements: Record<string, FakeElement>, id: string): Promise<void> {
  const el = elements[id] as unknown as { onclick?: () => Promise<unknown> };
  assert.ok(el.onclick, `${id} has no onclick handler bound`);
  await el.onclick!();
}
