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
    slice("function urlToState() {", "let transcriptObserver"),
    "urlToState().view;",
  ].join("\n");
  const context = vm.createContext({
    URLSearchParams,
    API_BASE: "/admin",
    scope: "org",
    location: { pathname, search },
  });
  return vm.runInContext(src, context);
}

test("onboarding is a navigable view", () => {
  assert.match(html, /\{ label: "Admin", views: \["onboarding",/);
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

test("a keyed custom provider makes its base model ready", () => {
  const src = [
    slice("function onboardingProviderForModel(modelId) {", "function renderOnboardingProviderOptions"),
    "onboardingModelStatus('acme-large');",
  ].join("\n");
  const context = vm.createContext({
    onboardingModels: { "acme-gateway": [{ id: "acme-large", name: "Acme Large" }] },
    onboardingModelStatuses: [],
    onboardingCustomProviderStatuses: [{ id: "acme-gateway", disabled: false, hasKey: true }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(src, context))), {
    provider: "acme-gateway",
    configured: true,
    source: "custom",
  });
});

test("onboarding loads the custom provider table on entry", () => {
  assert.match(
    slice("async function loadOnboarding() {", '$("onboarding-model-provider").onchange'),
    /await loadCustomProviders\(\)/,
  );
});

test("custom provider mutations refresh onboarding readiness", () => {
  const handlers = slice("async function loadCustomProviders() {", "function openOnboardingTarget");
  assert.equal(handlers.match(/await loadOnboarding\(\)/g)?.length, 2);
});
