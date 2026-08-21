import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const composer = read("../src/composer.ts");
const css = read("../src/shell.css");
const shell = read("../src/shell.ts");

test("boot hands its runtime config to the composer instead of dropping it", () => {
  assert.match(shell, /const personalScope = personalScopeIdFor\(appState\.me\.user\);/);
  assert.match(shell, /seedRuntimeConfig\(personalScope, runtimeConfig\);/);
  const fetchAt = shell.indexOf("await fetchRuntimeConfig(personalScope)");
  const seedAt = shell.indexOf("seedRuntimeConfig(personalScope, runtimeConfig)");
  assert.ok(fetchAt > 0 && seedAt > fetchAt, "boot must seed the config it just fetched");
});

test("runtime selection consults the scoped cache before blanking or fetching", () => {
  const start = composer.indexOf("async function refreshRuntimeSelection");
  const end = composer.indexOf("function applySelectedRuntime", start);
  assert.ok(start >= 0 && end > start, "refreshRuntimeSelection not found");
  const body = composer.slice(start, end);
  const cacheRead = body.indexOf("runtimeConfigCache.get(scopeKey)");
  const blank = body.indexOf("activeRuntimeConfig = null");
  const fetchCall = body.indexOf("await fetchRuntimeConfig(scopeId)");
  assert.ok(cacheRead >= 0 && cacheRead < blank && cacheRead < fetchCall);
  assert.match(
    body,
    /if \(cached\) \{\s*activateRuntimeCatalog\(scopeKey, cached\);\s*applySelectedRuntime\(cached, agent\);\s*return;\s*\}/,
  );
  assert.doesNotMatch(body.slice(cacheRead, blank), /runtimeConfigCache\.set/, "a cache hit must not refresh its TTL");
  const revision = body.indexOf("runtimeConfigCache.revision(scopeKey)");
  const fetch = body.indexOf("await fetchRuntimeConfig(scopeId)");
  const resolve = body.indexOf("runtimeConfigCache.resolveFetch(scopeKey, cacheRevision, config)");
  const failure = body.indexOf("if (!selected)");
  assert.ok(revision > blank && fetch > revision && resolve > fetch && failure > resolve);
});

test("successful scope updates survive a newer same-scope mount without overriding a newer mutation", () => {
  const start = composer.indexOf("async function changeScopeRuntime");
  const end = composer.indexOf("function composerForm", start);
  assert.ok(start >= 0 && end > start, "changeScopeRuntime not found");
  const body = composer.slice(start, end);
  const requestScope = body.indexOf("const requestedScopeKey = runtimeScopeKey(scopeId)");
  const mutation = body.indexOf("const mutationRequest = ++runtimeMutationRequest");
  const update = body.indexOf("await updateCachedRuntimeConfig(requestedScopeKey");
  const request = body.indexOf("updateRuntimeConfig(requestedScopeKey, change)");
  const scope = body.indexOf("const updatedScopeKey = config.scopeId");
  const guard = body.indexOf("mutationRequest !== runtimeMutationRequest", update);
  const activate = body.indexOf("activateRuntimeCatalog(updatedScopeKey, config)");
  const apply = body.indexOf("applySelectedRuntime(config, ctx.chat.state.agent ?? undefined)");
  assert.ok(
    requestScope > 0 &&
      mutation > 0 &&
      update > requestScope &&
      request > update &&
      scope > request &&
      guard > scope &&
      activate > guard &&
      apply > activate,
  );
  assert.doesNotMatch(body.slice(update), /request !== runtimeRequest/);
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
  assert.match(css, /^\.composer-error \{\r?\n {2}color: var\(--destructive/m);
});
