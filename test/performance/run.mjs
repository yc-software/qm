import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACHMENT, BLOCKING_SELECTORS, buildCatalog, cellsFor, chatReady, multiviewState } from "./catalog.mjs";
import { sha256, verifyRun } from "./verify.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const INTERACTIVE_KINDS = new Set([
  "earlier",
  "sidebar-switch",
  "sidebar-more",
  "admin-next",
  "web-overlay",
  "hidden-tab",
  "attachment",
  "disabled-crons",
  "memory-facts",
]);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const plainError = (error) => ({
  name: error?.name ?? "Error",
  message: String(error?.message ?? error).slice(0, 3000),
  stack: typeof error?.stack === "string" ? error.stack.slice(0, 12000) : undefined,
});

export function validateReadySpec(spec) {
  assert.ok(spec && typeof spec.root === "string" && spec.root.length, "Readiness needs an explicit rendered root");
  assert.deepEqual(spec.missing ?? [], [], "Fixture lacks required readiness data");
  assert.ok(
    (Array.isArray(spec.texts) &&
      spec.texts.length &&
      spec.texts.every((text) => typeof text === "string" && text.trim().length > 0)) ||
      (Array.isArray(spec.values) &&
        spec.values.length &&
        spec.values.every((entry) => typeof entry.selector === "string" && typeof entry.value === "string")) ||
      (spec.visible && (spec.editable || spec.enabled)),
    "Readiness needs fixture content or a fixture-specific visible target and usable control",
  );
  assert.ok(!["body", "html"].includes(spec.root) || spec.visible, "Document-only readiness is forbidden");
}

export async function waitReady(page, specs) {
  for (const spec of [specs].flat()) {
    validateReadySpec(spec);
    const root = page.locator(spec.root).first();
    await root.waitFor({ state: "visible" });
    for (const text of spec.texts ?? [])
      await root.getByText(text, { exact: false }).first().waitFor({ state: "visible" });
    for (const text of spec.absentTexts ?? [])
      await root.getByText(text, { exact: false }).first().waitFor({ state: "hidden" });
    for (const selector of spec.absentSelectors ?? [])
      await root.locator(selector).first().waitFor({ state: "hidden" });
    for (const row of spec.rowTexts ?? []) {
      let locator = root.locator(row.selector);
      for (const text of row.texts) locator = locator.filter({ hasText: text });
      await locator.first().waitFor({ state: "visible" });
    }
    for (const { selector, value } of spec.values ?? []) {
      await root.locator(selector).first().waitFor({ state: "attached" });
      await page.waitForFunction(
        ({ rootSelector, selector, value }) =>
          [...globalThis.document.querySelectorAll(rootSelector)].some(
            (element) => element.getBoundingClientRect().width > 0 && element.querySelector(selector)?.value === value,
          ),
        { rootSelector: spec.root, selector, value },
      );
    }
    if (spec.visible) await root.locator(spec.visible).first().waitFor({ state: "visible" });
    if (spec.editable) {
      const input = root
        .locator(spec.editable)
        .and(page.locator(':not(:disabled):not([readonly]):not([aria-disabled="true"])'))
        .filter({ visible: true })
        .first();
      await input.waitFor({ state: "visible" });
      assert.ok(await input.isEditable(), "Composer is not editable");
    }
    if (spec.enabled) {
      const control = root
        .locator(spec.enabled)
        .and(page.locator(':not(:disabled):not([aria-disabled="true"])'))
        .filter({ visible: true })
        .first();
      await control.waitFor({ state: "visible" });
      assert.ok(await control.isEnabled(), "Required control is disabled");
    }
    if (spec.rows) {
      assert.ok(
        Number.isInteger(spec.rows.minimum) && spec.rows.minimum > 0,
        "Row readiness requires a positive minimum",
      );
      await page.waitForFunction(
        ({ rootSelector, selector, minimum }) =>
          [...globalThis.document.querySelectorAll(rootSelector)].some(
            (element) =>
              element.getBoundingClientRect().width > 0 && element.querySelectorAll(selector).length >= minimum,
          ),
        { rootSelector: spec.root, selector: spec.rows.selector, minimum: spec.rows.minimum },
      );
    }
  }
  await page.locator(BLOCKING_SELECTORS).first().waitFor({ state: "hidden" });
  assert.equal(
    await page.locator('[role="alert"]:visible:not(.dv-live-region-assertive:empty)').count(),
    0,
    "The page shows an error alert",
  );
  await page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
  );
}

export function validateConfig(config) {
  const url = new URL(config.baseUrl);
  assert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "baseUrl must be a plain origin",
  );
  assert.equal(config.isolated, true, "An explicitly isolated fixture is required; never use production");
  assert.ok(["diagnostic", "qualifying"].includes(config.mode), "mode must be explicit");
  assert.ok(["normal", "peak", "burst"].includes(config.loadCondition), "loadCondition must be normal, peak or burst");
  assert.ok(
    Number.isInteger(config.samples) && config.samples > 0 && config.samples <= 1000,
    "samples must be 1..1000",
  );
  assert.ok(
    config.mode !== "qualifying" || (config.samples >= 31 && !config.filter),
    "Qualifying runs need >=31 samples and the full catalog",
  );
  assert.ok(
    config.cacheFilter === undefined || (config.mode === "diagnostic" && ["cold", "warm"].includes(config.cacheFilter)),
    "cacheFilter is supported only for explicit diagnostic cache modes",
  );
  assert.ok(
    typeof config.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(config.sourceRevision),
    "An exact source revision is required",
  );
  assert.ok(
    config.browser?.viewport?.width > 0 && config.browser?.viewport?.height > 0,
    "Set a browser viewport explicitly",
  );
  assert.ok(
    Number.isFinite(config.browser?.cpuThrottleRate) && config.browser.cpuThrottleRate >= 1,
    "Set cpuThrottleRate explicitly",
  );
  const network = config.browser?.network;
  assert.ok(
    network &&
      Number.isFinite(network.latencyMs) &&
      network.latencyMs >= 0 &&
      network.downloadBytesPerSecond > 0 &&
      network.uploadBytesPerSecond > 0,
    "Set explicit network latency and throughput",
  );
  assert.ok(
    !config.connectOverCDP && !config.userDataDir && !config.channel,
    "Existing user browser profiles are never used",
  );
}

function shuffle(array, seed) {
  let state = seed >>> 0;
  for (let i = array.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const navigate = (page, baseUrl, path) => page.goto(new URL(path, baseUrl).href, { waitUntil: "domcontentloaded" });
const sessionLink = (page, session) =>
  page
    .locator(`[data-session-id=${JSON.stringify(session.sessionId)}] a.session`)
    .filter({ visible: true })
    .first();

export async function establishSplitState(request, baseUrl, principalId, value) {
  const me = await request.get(new URL("/me", baseUrl).href);
  assert.ok(me.ok(), "Fixture authentication setup failed");
  assert.equal((await me.json()).user, principalId, "Refusing to change another principal's UI state");
  const url = new URL("/api/ui-state?key=split-canvas", baseUrl).href;
  const prior = await request.get(url);
  assert.ok(prior.ok(), "Cannot read fixture UI state");
  const old = await prior.json();
  assert.ok(Number.isSafeInteger(old.updatedAt) && old.updatedAt >= 0, "Invalid UI state timestamp");
  const updatedAt = Math.max(Date.now(), old.updatedAt + 1);
  const state = { ...value, updatedAt };
  const saved = await request.put(new URL("/api/ui-state", baseUrl).href, {
    headers: { origin: new URL(baseUrl).origin },
    data: { key: "split-canvas", value: state, updatedAt },
  });
  assert.ok(saved.ok() && (await saved.json()).ok, "Fixture UI state write was rejected");
  const response = await request.get(url);
  assert.ok(response.ok(), "Cannot verify fixture UI state");
  const verified = await response.json();
  assert.deepEqual(verified.value, state, "Fixture UI state was not persisted exactly");
  return { ...state, updatedAt: verified.updatedAt };
}

async function prepare(page, scenario, cache, baseUrl) {
  const interact = INTERACTIVE_KINDS.has(scenario.kind);
  if (cache === "cold" && !interact) return;
  await navigate(page, baseUrl, scenario.path);
  if (scenario.kind === "earlier") {
    await waitReady(page, scenario.prepareReady);
    for (const ready of scenario.preparePages ?? []) {
      await page.getByRole("button", { name: "Show earlier messages", exact: true }).first().click();
      await waitReady(page, ready);
    }
    for (const selector of scenario.prepareReady.absentSelectors ?? [])
      assert.equal(await page.locator(selector).count(), 0, "Measured earlier-page target is already rendered");
    await page
      .getByRole("button", { name: "Show earlier messages", exact: true })
      .first()
      .waitFor({ state: "visible" });
  } else if (scenario.kind === "sidebar-switch") {
    await waitReady(page, scenario.prepareReady);
    for (let attempts = 0; !(await sessionLink(page, scenario.session).count()); attempts++) {
      assert.ok(attempts < 100, "Sidebar target is absent after 100 pages");
      const before = await page.locator("[data-session-id] a.session").count();
      await page.getByRole("button", { name: "Show more conversations", exact: true }).click();
      await page.waitForFunction(
        (count) => globalThis.document.querySelectorAll("[data-session-id] a.session").length > count,
        before,
      );
    }
    await sessionLink(page, scenario.session).waitFor({ state: "visible" });
  } else if (scenario.kind === "sidebar-more") {
    await page.locator(".settings-page").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "Show more conversations", exact: true })
      .first()
      .waitFor({ state: "visible" });
    assert.equal(
      await page.locator(scenario.ready.visible).filter({ visible: true }).count(),
      0,
      "Pagination target is already visible on the first page",
    );
  } else if (scenario.kind === "hidden-tab") {
    await waitReady(
      page,
      scenario.visibleIndices.map((i) => chatReady(scenario.sessions[i], `perf-pane-${i}`)),
    );
    await page.getByRole("tab").filter({ hasText: scenario.sessions[0].title }).first().click();
    await waitReady(page, scenario.ready);
    await page
      .getByRole("tab")
      .filter({ hasText: scenario.sessions[scenario.visibleIndices[0]].title })
      .first()
      .click();
    await waitReady(
      page,
      chatReady(scenario.sessions[scenario.visibleIndices[0]], `perf-pane-${scenario.visibleIndices[0]}`),
    );
  } else if (scenario.kind === "web-overlay") {
    await page.locator(".custom-chat textarea:visible").first().waitFor({ state: "visible" });
  } else {
    await waitReady(page, scenario.prepareReady ?? scenario.ready);
  }
}

async function action(page, scenario, cache, baseUrl) {
  if (scenario.kind === "attachment")
    await page
      .locator(".custom-chat .file-input")
      .first()
      .setInputFiles({ name: ATTACHMENT.name, mimeType: ATTACHMENT.mimeType, buffer: Buffer.from(ATTACHMENT.text) });
  else if (scenario.kind === "disabled-crons") await page.locator(".cron-disabled-toggle").click();
  else if (scenario.kind === "memory-facts")
    await page.getByRole("button", { name: "Facts view", exact: true }).click();
  else if (scenario.kind === "earlier")
    await page.getByRole("button", { name: "Show earlier messages", exact: true }).first().click();
  else if (scenario.kind === "sidebar-switch") await sessionLink(page, scenario.session).click();
  else if (scenario.kind === "sidebar-more")
    await page.getByRole("button", { name: "Show more conversations", exact: true }).first().click();
  else if (scenario.kind === "admin-next") await page.getByRole("button", { name: "Next →", exact: true }).click();
  else if (scenario.kind === "web-overlay") {
    await page
      .getByRole("button", { name: scenario.overlay === "search" ? "Search" : "Browse", exact: true })
      .first()
      .click();
    if (scenario.overlay === "search") await page.locator(".chat-search-input").fill(scenario.query);
  } else if (scenario.kind === "hidden-tab") {
    const target = page.getByRole("tab").filter({ hasText: scenario.sessions[0].title }).first();
    await target.click();
  } else if (cache === "warm") await page.reload({ waitUntil: "domcontentloaded" });
  else await navigate(page, baseUrl, scenario.path);
}

export function requiredResponsesComplete(requests, requirements) {
  return requirements.every((requirement) => {
    const matching = requests.filter(
      (entry) => entry.sameOrigin !== false && entry.path === requirement.path && entry.method === "GET",
    );
    return (
      matching.length > 0 &&
      matching.every(
        (entry) =>
          entry.completed &&
          (requirement.expectedStatuses
            ? requirement.expectedStatuses.includes(entry.status)
            : entry.status >= 200 && entry.status < 300) &&
          (!requirement.expectedError || entry.expectedErrorMatched === true),
      ) &&
      (!requirement.paginated || matching.some((entry) => entry.finalPage === true)) &&
      (!requirement.settledField || matching.some((entry) => entry.settled === true)) &&
      (!requirement.followupWhenNonempty ||
        (matching.every((entry) => entry.followupRequired !== undefined) &&
          (!matching.some((entry) => entry.followupRequired) ||
            requiredResponsesComplete(requests, [{ path: requirement.followupPath }]))))
    );
  });
}

export function observe(page, origin, requirements) {
  const requests = [];
  const errors = [];
  const byRequest = new Map();
  const pending = new Set();
  const changed = new Set();
  const notify = () => {
    for (const listener of changed) listener();
  };
  let identity;
  let active = false;
  let generation = 0;
  page.on("pageerror", (error) => {
    if (active) errors.push({ type: "pageerror", ...plainError(error) });
  });
  page.on("request", (request) => {
    if (!active) return;
    const url = new URL(request.url());
    const entry = {
      path: url.pathname,
      origin: url.origin,
      sameOrigin: url.origin === origin,
      method: request.method(),
      resourceType: request.resourceType(),
      startedAt: Date.now(),
      timing: request.timing(),
      completed: false,
      phase: "started",
    };
    byRequest.set(request, entry);
    requests.push(entry);
    notify();
  });
  page.on("requestfailed", (request) => {
    const entry = byRequest.get(request);
    if (!active || !entry) return;
    entry.phase = "failed";
    entry.failedAt = Date.now();
    entry.failure = request.failure()?.errorText;
    entry.timing = request.timing();
    if (entry.sameOrigin && entry.failure !== "net::ERR_ABORTED")
      errors.push({ type: "requestfailed", path: entry.path, message: entry.failure });
    notify();
  });
  page.on("response", (response) => {
    const request = response.request();
    const entry = byRequest.get(request);
    if (!active || !entry) return;
    const observedGeneration = generation;
    entry.status = response.status();
    entry.phase = "response";
    entry.responseAt = Date.now();
    entry.timing = request.timing();
    entry.fromServiceWorker = response.fromServiceWorker();
    if (entry.sameOrigin && ["/me", "/admin/api/me"].includes(entry.path) && entry.status === 200) {
      const job = response
        .json()
        .then((data) => {
          if (generation === observedGeneration) identity = data.principal ?? data.user;
        })
        .catch(() => {});
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }
    const requirement = requirements.find((item) => item.path === entry.path);
    if (
      entry.sameOrigin &&
      requirement &&
      (requirement.paginated ||
        requirement.settledField ||
        requirement.followupWhenNonempty ||
        requirement.expectedError)
    ) {
      const job = response
        .json()
        .then((data) => {
          if (generation !== observedGeneration) return;
          if (requirement.paginated) entry.finalPage = Array.isArray(data.items) && !data.nextCursor;
          if (requirement.settledField) entry.settled = !data[requirement.settledField];
          if (requirement.followupWhenNonempty)
            entry.followupRequired = (data[requirement.followupWhenNonempty]?.length ?? 0) > 0;
          if (requirement.expectedError) {
            entry.errorCode = data.error;
            entry.expectedErrorMatched =
              requirement.expectedStatuses.includes(entry.status) && data.error === requirement.expectedError;
          }
          notify();
        })
        .catch(() => {})
        .then(() => {
          if (generation !== observedGeneration) return;
          if (requirement.expectedError && !entry.expectedErrorMatched)
            errors.push({
              type: "contract",
              path: entry.path,
              status: entry.status,
              message: "Response did not match the declared disabled-feature contract",
            });
        });
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }
    if (entry.sameOrigin && entry.status >= 400 && !requirement?.expectedError)
      errors.push({ type: "http", path: entry.path, status: entry.status });
    const job = response
      .allHeaders()
      .then((headers) => {
        if (generation !== observedGeneration) return;
        entry.encoding = headers["content-encoding"] ?? null;
        entry.contentLength = headers["content-length"] ? Number(headers["content-length"]) : null;
        entry.serverTiming = headers["server-timing"] ?? null;
        entry.contentType = headers["content-type"] ?? null;
      })
      .catch((error) => {
        if (generation === observedGeneration) errors.push({ type: "headers", ...plainError(error) });
      });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  page.on("requestfinished", (request) => {
    const entry = byRequest.get(request);
    if (!active || !entry) return;
    const observedGeneration = generation;
    entry.phase = "finished";
    entry.finishedAt = Date.now();
    const job = request
      .sizes()
      .then((sizes) => {
        if (generation !== observedGeneration) return;
        entry.bytes = sizes;
        entry.timing = request.timing();
        entry.completed = true;
        notify();
      })
      .catch(() => {});
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return {
    async waitResponses(timeoutMs) {
      if (requiredResponsesComplete(requests, requirements)) return;
      await new Promise((resolve, reject) => {
        const done = () => {
          if (!requiredResponsesComplete(requests, requirements)) return;
          clearTimeout(timer);
          changed.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          changed.delete(done);
          const unfinished = requirements.filter((requirement) => !requiredResponsesComplete(requests, [requirement]));
          reject(
            new Error(`Required page requests did not finish: ${unfinished.map((entry) => entry.path).join(", ")}`),
          );
        }, timeoutMs);
        changed.add(done);
        done();
      });
    },
    start() {
      generation++;
      byRequest.clear();
      pending.clear();
      requests.length = 0;
      errors.length = 0;
      active = true;
    },
    async finish() {
      active = false;
      await Promise.all(pending);
      const now = Date.now();
      for (const entry of requests)
        if (!entry.completed && entry.phase !== "failed") entry.pendingForMs = now - entry.startedAt;
      return { requests, errors, identity };
    },
  };
}

async function sample(browser, config, scenario, cell, iteration, output) {
  const result = {
    schemaVersion: 1,
    cellId: cell.id,
    scenarioId: scenario.id,
    cache: cell.cache,
    condition: cell.condition,
    iteration,
    status: "failed",
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
  };
  let context;
  let measurementStart;
  let observer;
  try {
    if (scenario.missing.length) {
      result.status = "unsupported";
      throw new Error(`Fixture prerequisites missing: ${scenario.missing.join(", ")}`);
    }
    for (const spec of [scenario.ready, scenario.prepareReady].flat().filter(Boolean)) validateReadySpec(spec);
    const storageState =
      config.authStates?.[scenario.principalId] ?? (scenario.admin ? config.adminAuthState : undefined);
    assert.ok(
      storageState || config.localAuthPrincipal === scenario.principalId,
      `No authentication state for ${scenario.principalId}`,
    );
    context = await browser.newContext({
      viewport: config.browser.viewport,
      locale: "en-US",
      timezoneId: "UTC",
      serviceWorkers: "block",
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs ?? 15_000);
    page.setDefaultNavigationTimeout(config.timeoutMs ?? 15_000);
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: config.browser.network.latencyMs,
      downloadThroughput: config.browser.network.downloadBytesPerSecond,
      uploadThroughput: config.browser.network.uploadBytesPerSecond,
    });
    await session.send("Emulation.setCPUThrottlingRate", { rate: config.browser.cpuThrottleRate });
    const state = await establishSplitState(
      context.request,
      config.baseUrl,
      scenario.principalId,
      ["multiview", "hidden-tab"].includes(scenario.kind)
        ? multiviewState(scenario.sessions, 0, scenario.visibleGroups)
        : { v: 2, active: false },
    );
    result.uiStateSetup = {
      principalId: scenario.principalId,
      updatedAt: state.updatedAt,
      sha256: sha256(JSON.stringify(state)),
    };
    await page.addInitScript(
      ({ origin, state }) => {
        if (globalThis.location.origin === origin)
          globalThis.localStorage.setItem("web-ui:split-canvas:v1", JSON.stringify(state));
        globalThis.__qmPerformance = { longTasks: [] };
        new globalThis.PerformanceObserver((list) =>
          globalThis.__qmPerformance.longTasks.push(
            ...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
          ),
        ).observe({ type: "longtask", buffered: true });
      },
      { origin: config.baseUrl, state },
    );
    observer = observe(page, config.baseUrl, scenario.requiredResponses);
    observer.start();
    await prepare(page, scenario, cell.cache, config.baseUrl);
    if (cell.cache === "warm" && scenario.kind !== "web-overlay")
      await observer.waitResponses(config.timeoutMs ?? 15_000);
    if (INTERACTIVE_KINDS.has(scenario.kind))
      await page.evaluate(() => {
        performance.clearResourceTimings();
        globalThis.__qmPerformance.longTasks = [];
      });
    result.startedAt = Date.now();
    measurementStart = performance.now();
    observer.start();
    await action(page, scenario, cell.cache, config.baseUrl);
    await observer.waitResponses(config.timeoutMs ?? 15_000);
    await waitReady(page, scenario.ready);
    result.durationMs = performance.now() - measurementStart;
    result.finishedAt = Date.now();
    result.readiness = { passed: true, completedAt: result.finishedAt, assertions: scenario.ready };
    result.browser = await page.evaluate(() => ({
      navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
      resources: performance.getEntriesByType("resource").map((entry) => ({
        path: new URL(entry.name).pathname,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      })),
      longTasks: globalThis.__qmPerformance.longTasks,
      domNodes: globalThis.document.querySelectorAll("*").length,
      visibleSessionRows: [...globalThis.document.querySelectorAll("[data-session-id]")].filter(
        (element) => element.getBoundingClientRect().width > 0,
      ).length,
    }));
    for (const navigation of result.browser.navigation) delete navigation.name;
    const evidence = await observer.finish();
    Object.assign(result, evidence);
    assert.equal(evidence.identity, scenario.principalId, "Browser is authenticated as the wrong fixture principal");
    assert.deepEqual(evidence.errors, [], "Browser/request errors occurred during measurement");
    result.status = "pass";
  } catch (error) {
    result.error = plainError(error);
    if (measurementStart !== undefined && result.durationMs === null)
      result.durationMs = performance.now() - measurementStart;
    result.finishedAt ??= Date.now();
    if (observer) Object.assign(result, await observer.finish());
    if (context) {
      const page = context.pages()[0];
      if (page) {
        result.finalUrl = page.url();
        result.visibleAlerts = await page
          .locator('[role="alert"]:visible')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              text: element.textContent?.slice(0, 3000) ?? "",
              outerHTML: element.outerHTML.slice(0, 5000),
              bounds: element.getBoundingClientRect().toJSON(),
            })),
          )
          .catch(() => []);
        await page
          .screenshot({
            path: resolve(output, `failure-${cell.id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}-${iteration}.png`),
            timeout: 3000,
          })
          .catch(() => {});
      }
    }
  } finally {
    if (context) await context.close();
  }
  return result;
}

export async function run(configPath, listOnly = false) {
  const configDirectory = dirname(resolve(configPath));
  const config = json(resolve(configPath));
  validateConfig(config);
  config.baseUrl = new URL(config.baseUrl).origin;
  const fromConfig = (path) => resolve(configDirectory, path);
  const fixtureBytes = readFileSync(fromConfig(config.fixturePath));
  const fixture = JSON.parse(fixtureBytes);
  const profiles = (config.profilePaths ?? [config.profilePath]).flatMap((path) => {
    const value = json(fromConfig(path));
    return Array.isArray(value) ? value : [value];
  });
  const profileHash = sha256(JSON.stringify(profiles));
  assert.ok(typeof fixture.fixtureId === "string" && fixture.fixtureId, "Fixture identity is required");
  assert.equal(fixture.profileSha256, profileHash, "Fixture was seeded from a different profile");
  const catalog = buildCatalog(fixture);
  const selected = config.filter ? catalog.filter((scenario) => new RegExp(config.filter).test(scenario.id)) : catalog;
  assert.ok(selected.length, "No catalog scenarios matched");
  if (listOnly) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  for (const key of Object.keys(config.authStates ?? {})) config.authStates[key] = fromConfig(config.authStates[key]);
  if (config.adminAuthState) config.adminAuthState = fromConfig(config.adminAuthState);
  if (config.localAuthPrincipal)
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.baseUrl).hostname),
      "Local auth is only permitted on loopback",
    );
  const output = fromConfig(config.outDir);
  assert.ok(
    !existsSync(resolve(output, "run.json")),
    "Refusing to replace previous evidence; choose a fresh output directory",
  );
  mkdirSync(output, { recursive: true });
  const write = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
  const cells = cellsFor(selected, config.loadCondition).filter(
    (cell) => !config.cacheFilter || cell.cache === config.cacheFilter,
  );
  const startedAt = Date.now();
  const runState = {
    schemaVersion: 1,
    runId: randomUUID(),
    mode: config.mode,
    baseUrl: config.baseUrl,
    fixtureId: fixture.fixtureId,
    sourceRevision: config.sourceRevision,
    profileSha256: profileHash,
    fixtureSha256: sha256(fixtureBytes),
    catalogSha256: sha256(readFileSync(resolve(dirname(sourcePath), "catalog.mjs"))),
    runnerSha256: sha256(readFileSync(sourcePath)),
    samplesPerCell: config.samples,
    thresholdMs: 1000,
    loadCondition: config.loadCondition,
    filtered: Boolean(config.filter || config.cacheFilter),
    browser: config.browser,
    requiredCells: cells.map((cell) => cell.id),
    catalog: selected,
    startedAt,
    status: "running",
    measurementStartedAt: startedAt,
    measurementFinishedAt: null,
  };
  write("run.json", runState);
  write("fixture.json", fixture);
  const envelope = config.envelopePath ? json(fromConfig(config.envelopePath)) : undefined;
  if (envelope) write("envelope.json", envelope);
  if (config.mode === "qualifying") {
    assert.ok(
      envelope?.isolated && envelope.baseUrl === config.baseUrl && envelope.fixtureId === fixture.fixtureId,
      "Qualification requires matching isolated environment evidence before browser launch",
    );
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(config.executablePath ? { executablePath: fromConfig(config.executablePath) } : {}),
  });
  runState.browserVersion = browser.version();
  const samples = [];
  try {
    for (let iteration = 0; iteration < config.samples; iteration++) {
      for (const cell of shuffle([...cells], (config.orderSeed ?? 7349) + iteration)) {
        const scenario = selected.find((entry) => entry.id === cell.scenarioId);
        const observation = await sample(browser, config, scenario, cell, iteration, output);
        samples.push(observation);
        appendFileSync(resolve(output, "samples.jsonl"), JSON.stringify(observation) + "\n");
        console.log(
          JSON.stringify({
            cell: cell.id,
            iteration,
            status: observation.status,
            durationMs: observation.durationMs,
            error: observation.error?.message,
          }),
        );
      }
    }
    runState.status = "completed";
  } finally {
    runState.measurementStartedAt = samples.length ? Math.min(...samples.map((entry) => entry.startedAt)) : startedAt;
    runState.measurementFinishedAt = samples.length
      ? Math.max(...samples.map((entry) => entry.finishedAt))
      : Date.now();
    runState.finishedAt = Date.now();
    write("run.json", runState);
    await browser.close();
  }
  const workload =
    config.workloadPath && existsSync(fromConfig(config.workloadPath))
      ? json(fromConfig(config.workloadPath))
      : undefined;
  if (workload) write("workload.json", workload);
  const producer =
    config.producerPath && existsSync(fromConfig(config.producerPath))
      ? json(fromConfig(config.producerPath))
      : undefined;
  if (producer) write("producer.json", producer);
  const summary = verifyRun(runState, samples, fixture, envelope, workload, producer);
  write("summary.json", summary);
  console.log(
    JSON.stringify({
      output,
      pass: summary.pass,
      qualified: summary.qualified,
      reasons: summary.reasons,
      qualificationReasons: summary.qualificationReasons,
    }),
  );
  process.exitCode = (config.mode === "qualifying" ? summary.qualified : summary.pass) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === sourcePath)
  await run(process.argv[2], process.argv.includes("--list"));
