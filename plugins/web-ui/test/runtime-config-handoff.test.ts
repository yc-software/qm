import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("boot hands its runtime config to the composer instead of dropping it", () => {
  assert.match(shell, /const personalScope = `personal:\$\{appState\.me\.user\}`;/);
  assert.match(shell, /seedRuntimeConfig\(personalScope, runtimeConfig\);/);
  const fetchAt = shell.indexOf("await fetchRuntimeConfig(personalScope)");
  const seedAt = shell.indexOf("seedRuntimeConfig(personalScope, runtimeConfig)");
  assert.ok(fetchAt > 0 && seedAt > fetchAt, "boot must seed the config it just fetched");
});

test("composers read the shared boot snapshot without consuming or copying it", () => {
  assert.match(composer, /const activeRuntimeConfig = getRuntimeConfig\(scopeKey\(\)\);/);
  assert.match(composer, /await loadRuntimeConfig\(key, refresh\)/);
  assert.doesNotMatch(composer, /seededRuntime|applyRuntimeOptions|let activeRuntimeConfig/);
});

test("a still-loading composer is not painted as a failure", () => {
  const branch = composer.slice(
    composer.indexOf("} else if (!approvalPauses.length && runtimePending) {"),
    composer.indexOf("} else if (composerState.error) {"),
  );
  assert.ok(branch, "the runtime-pending branch not found");
  assert.match(branch, /composerState\.error\s*\?/, "the branch must split on a real error");
  assert.match(branch, /class="composer-note">Loading runtime settings…/, "loading is a note");
  const loadingAt = branch.indexOf("Loading runtime settings…");
  const errorClassAt = branch.indexOf('class="composer-error"');
  assert.ok(errorClassAt >= 0 && errorClassAt < loadingAt, "only the real error keeps the error class");
  assert.ok(
    !/class="composer-error">[\s\S]{0,80}Loading runtime settings…/.test(branch),
    "the loading placeholder must not render inside .composer-error",
  );
  const retryAt = branch.indexOf("Retry");
  assert.ok(retryAt >= 0 && retryAt < loadingAt, "Retry stays on the error side");
});

test(".composer-error is the destructive colour — which is why loading must not use it", () => {
  assert.match(css, /^\.composer-error \{\n {2}color: var\(--destructive/m);
});

test("a personal mount passing null still matches the seeded personal scope", () => {
  const resolver = composer.slice(
    composer.indexOf("function runtimeScopeKey"),
    composer.indexOf("function modelOptionFor"),
  );
  assert.ok(resolver, "runtimeScopeKey not found");
  assert.match(resolver, /if \(scopeId\) return scopeId;/, "a named scope is used as-is");
  assert.match(resolver, /return user \? `personal:\$\{user\}` : null;/, "null resolves to the personal scope");
});
