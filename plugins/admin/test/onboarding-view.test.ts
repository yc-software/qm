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
  href: string;
  options: Array<{ value?: string; textContent?: string }>;
  appendChild(option: { value?: string; textContent?: string }): void;
}

async function runLoadOnboarding(modelProviders: unknown): Promise<Record<string, FakeElement>> {
  const src = slice("let onboardingModels = {};", '$("onboarding-model-provider").onchange') + "\nloadOnboarding();";
  const elements: Record<string, FakeElement> = {};
  const fixtures: Record<string, unknown> = {
    "/api/model-providers": modelProviders,
    "/api/slack-installation": { configured: false },
    "/api/connector-catalog": { catalog: [] },
    "/api/scopes/org%3Adefault-org": { baseModel: "claude-opus-5" },
  };
  const context = vm.createContext({
    $: (id: string) =>
      (elements[id] ??= {
        textContent: "",
        className: "",
        value: "",
        placeholder: "",
        disabled: false,
        href: "",
        options: [],
        appendChild(option) {
          this.options.push(option);
        },
      }),
    api: async (_method: string, path: string) => ({ ok: true, data: fixtures[path] ?? {} }),
    loadModelRegistry: async () => {},
    orgScope: () => "org:default-org",
    encodeURIComponent,
    setStatus: () => {},
    connectorName: (id: string) => id,
    viewLoadedAt: {},
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
