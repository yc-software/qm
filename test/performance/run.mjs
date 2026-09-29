import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTACHMENT,
  INTERACTIVE_KINDS,
  BLOCKING_SELECTORS,
  buildCatalog,
  cellsFor,
  chatReady,
  multiviewState,
  validateSidebarProfile,
} from "./catalog.mjs";
import { sha256, verifyRun, validateSidebarCapture, validateSidebarDom } from "./verify.mjs";
import { projectSidebarResponse } from "./sidebar-response.mjs";
import { retainSidebarProjection } from "./sidebar-retention.mjs";
import { pruneSidebarDomRecords, waitSidebarDom } from "./sidebar-dom.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const plainError = (error) => ({
  name: error?.name ?? "Error",
  message: String(error?.message ?? error).slice(0, 3000),
  stack: typeof error?.stack === "string" ? error.stack.slice(0, 12000) : undefined,
});

export function readDynamicSidebar(path, fixtureRaw, profile, condition, fixturePath) {
  assert.equal(resolve(path), path, "Resolved dynamic sidebar path required");
  validateSidebarProfile(profile);
  const cap = 4194304;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw;
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= cap, "Bounded regular dynamic sidebar file required");
    const buffer = Buffer.allocUnsafe(cap + 1);
    let count = 0;
    for (let size; count < buffer.length && (size = readSync(fd, buffer, count, buffer.length - count, count));)
      count += size;
    assert.ok(count > 0 && count <= cap, "Dynamic sidebar exceeds input bound");
    raw = buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
  assert.ok(Buffer.isBuffer(fixtureRaw) && fixtureRaw.length > 0 && fixtureRaw.length <= cap);
  const parse = (bytes) => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  const fixture = parse(fixtureRaw),
    data = parse(raw);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.qualified, false, "Runtime data is not native qualification");
  assert.equal(data.commonFixture.bytes, fixtureRaw.length);
  assert.equal(data.commonFixture.sha256, sha256(fixtureRaw), "Dynamic sidebar belongs to a different common fixture");
  assert.equal(resolve(fixturePath), fixturePath);
  assert.equal(data.commonFixture.path, fixturePath);
  assert.deepEqual(data.profile, profile);
  assert.equal(data.condition, condition);
  assert.ok(["normal", "peak"].includes(condition));
  assert.equal(data.sourceProfile, profile.transport === "legacy-get" ? "baseline-observer" : "candidate");
  assert.ok(typeof data.campaignId === "string" && data.campaignId);
  assert.ok(Number.isSafeInteger(data.epochAt) && data.epochAt > 0);
  assert.deepEqual(data.missing, ["browser.sidebarReadiness.dynamic: response and native reconciliation required"]);
  const records = fixture.viewReadinessBySource.filter((row) => row.profile.sourceRevision === profile.sourceRevision);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].profile, profile);
  const commonActors = records[0].browser.sidebarReadiness.actors;
  assert.deepEqual(Object.keys(data.actors).sort(), Object.keys(commonActors).sort());
  assert.deepEqual(Object.keys(data.evidence).sort(), [
    "histories",
    "nativeConfig",
    "observations",
    "preparation",
    "slots",
    "snapshot",
  ]);
  for (const [role, value] of Object.entries(data.evidence)) {
    assert.equal(resolve(value.path), value.path);
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(value.bytes) &&
        value.bytes > 0 &&
        value.bytes <= ({ histories: 134217728, observations: 134217728, snapshot: 33554432 }[role] ?? cap),
    );
  }
  for (const [principalId, actor] of Object.entries(data.actors)) {
    for (const key of ["preparedNonWeb", "allowedOffPageRows", "contexts", "recurring", "scopePolicy"])
      assert.ok(Array.isArray(actor[key]), `Dynamic ${principalId} ${key} required`);
    for (const key of ["preparedWeb", "preparedOffPageWeb", "contexts"])
      assert.ok(Array.isArray(commonActors[principalId][key]), `Prepared ${principalId} ${key} required`);
  }
  return {
    data,
    commonActors,
    retention: { identities: new Map(), bytes: 0 },
    binding: {
      path,
      bytes: raw.length,
      sha256: sha256(raw),
      commonFixtureSha256: sha256(fixtureRaw),
      profile: data.profile,
      campaignId: data.campaignId,
      sourceProfile: data.sourceProfile,
      condition,
      epochAt: data.epochAt,
      nativeConfigSha256: data.evidence.nativeConfig.sha256,
    },
  };
}

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

export async function waitSidebarReady(page, spec, { limit = 50, retainedIds = [] } = {}) {
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.surface, "web", "A dynamic all-surface sidebar needs a separate admitted oracle");
  assert.ok(["legacy-get", "navigation-post"].includes(spec.transport));
  assert.match(spec.sourceRevision, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(limit) && limit >= 50 && limit <= 5000 && limit % 50 === 0);
  const allowed = new Set(spec.allowedOffPageRows.map((row) => row.id));
  assert.ok(
    retainedIds.every((id) => allowed.has(id)),
    "Unobserved retained sidebar identity",
  );
  const kept = new Set(retainedIds);
  const recent = spec.recent.allRows.filter((row, index) => index < limit || kept.has(row.id));
  const groups = spec.groups.items.filter(
    (group) =>
      spec.transport === "navigation-post" || group.count === 0 || recent.some((row) => row.scopeId === group.scopeId),
  );
  const groupedScopes = new Set(groups.map((group) => group.scopeId));
  const label = (value) => value.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
  const expected = {
    transport: spec.transport,
    recent: recent.map((row) => ({
      id: row.id,
      group: groupedScopes.has(row.scopeId) ? row.scopeId : "",
      title: label(groupedScopes.has(row.scopeId) ? row.groupedTitle : row.title),
    })),
    pinned: spec.pinned.rows.map((row) => ({ id: row.id, title: label(row.title) })),
    groups: groups.map((group) => ({
      scopeId: group.scopeId,
      name: label((group.name ?? { channel: "Channel", group: "Group DM" }[group.kind] ?? "Project").replace(/^#/, "")),
      count: group.count,
    })),
    totals: { recent: spec.recent.total, pinned: spec.pinned.total, groups: spec.groups.total },
    loaded: {
      recent: Math.min(limit, spec.recent.total),
      pinned: spec.pinned.rows.length,
      groups: spec.groups.items.length,
    },
    more: {
      recent:
        spec.transport === "navigation-post"
          ? spec.recent.total > limit
          : spec.recent.allRows.some((row, index) => index >= limit && !kept.has(row.id)),
      pinned: spec.pinned.hasMore,
      groups: spec.groups.hasMore,
    },
    archivedCount: spec.archivedCount,
  };
  const result = await page.waitForFunction((expected) => {
    const root = globalThis.document.querySelector("#sidebar-body");
    if (!root || !root.getClientRects().length) return false;
    const visible = (element) => Boolean(element?.getClientRects().length);
    const label = (value) => value?.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const bounded = expected.transport === "navigation-post";
    if (bounded) {
      if (
        root.dataset.sessionNavigation !== "ready" ||
        root.dataset.sessionNavigationMode !== "bounded" ||
        root.getAttribute("aria-busy") !== "false" ||
        root.dataset.sessionNavigationPending !== ""
      )
        return false;
      for (const section of ["recent", "pinned", "groups"]) {
        const name = section[0].toUpperCase() + section.slice(1);
        if (
          root.dataset[`session${name}Loaded`] !== String(expected.loaded[section]) ||
          root.dataset[`session${name}Total`] !== String(expected.totals[section])
        )
          return false;
      }
    }
    const scope = (element) => {
      if (!element) return "";
      if (bounded) return element.dataset.scopeId;
      const key = element.querySelector(".recent-project-menu [data-menu-id]")?.getAttribute("data-menu-id");
      return key?.startsWith("project:") ? key.slice(8) : undefined;
    };
    const rows = [...root.querySelectorAll(".session-row[data-session-id]")].filter(visible);
    if (new Set(rows.map((row) => row.dataset.sessionId)).size !== rows.length) return false;
    const pinned = [],
      recent = [];
    for (const row of rows) {
      if (row.closest(".archived-children")) return false;
      const link = row.querySelector("a.session");
      if (!visible(link) || link.getAttribute("aria-busy") === "true") return false;
      const item = { id: row.dataset.sessionId, title: label(row.querySelector(".tl")?.textContent) };
      if (row.closest(".pinned-children")) pinned.push(item);
      else recent.push({ ...item, group: scope(row.closest("section.recent-project")) });
    }
    if (!same(pinned, expected.pinned) || recent.length !== expected.recent.length) return false;
    for (const group of new Set(["", ...expected.groups.map((row) => row.scopeId)])) {
      const project = (rows) => rows.filter((row) => row.group === group).map(({ id, title }) => ({ id, title }));
      if (!same(project(recent), project(expected.recent))) return false;
    }
    const headers = [...root.querySelectorAll("section.recent-project")].filter(visible).map((element) => ({
      scopeId: scope(element),
      name: label(element.querySelector(".recent-project-name")?.textContent),
      count: Number(element.querySelector(".recent-project-count")?.textContent),
    }));
    if (!same(headers, expected.groups)) return false;
    for (const section of ["recent", "pinned", "groups"]) {
      const controls = bounded
        ? [...root.querySelectorAll(`[data-session-page="${section}"]`)].filter(visible)
        : [...root.querySelectorAll("button")].filter(
            (button) =>
              visible(button) && section === "recent" && button.textContent.trim() === "Show more conversations",
          );
      if (
        controls.length !== Number(expected.more[section]) ||
        controls.some((button) => button.disabled || button.getAttribute("aria-disabled") === "true")
      )
        return false;
    }
    const archived = [...root.querySelectorAll(".archived-count")].filter(visible);
    if (
      archived.length !== Number(expected.archivedCount > 0) ||
      (archived.length && archived[0].textContent.trim() !== String(expected.archivedCount))
    )
      return false;
    if ([...root.querySelectorAll('[role="alert"]')].some(visible)) return false;
    return { recent, pinned, groups: headers, archivedCount: expected.archivedCount };
  }, expected);
  return result.jsonValue();
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

function validateSidebarSettled(observer, proof) {
  assert.deepEqual(
    observer.sidebarSnapshot().capture,
    {
      generation: proof.generation,
      version: proof.version,
      ready: true,
      errors: [],
    },
    "Sidebar changed after rendered readiness",
  );
}

function waitScenarioSidebar(page, scenario, observer, options) {
  return scenario.sidebarReadiness.dynamic
    ? observer.waitSidebar(page, options)
    : waitSidebarReady(page, scenario.sidebarReadiness, options);
}

async function prepare(page, scenario, cache, baseUrl, observer, timeoutMs) {
  const interact = INTERACTIVE_KINDS.has(scenario.kind);
  let limit = 50;
  if (cache === "cold" && !interact) return { limit, prepared: false };
  await navigate(page, baseUrl, scenario.path);
  if (scenario.sidebarReadiness)
    await waitScenarioSidebar(page, scenario, observer, { retainedIds: sidebarRetainedIds(scenario, true) });
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
      await page.getByRole("button", { name: "Show more conversations", exact: true }).click();
      limit += 50;
      await waitScenarioSidebar(page, scenario, observer, {
        limit,
        retainedIds: sidebarRetainedIds(scenario, true),
      });
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
    await observer.waitActionable(page, actionableTargets(scenario, true), [], timeoutMs);
    await page.getByRole("tab").filter({ hasText: scenario.sessions[0].title }).first().click();
    await waitReady(page, scenario.ready);
    await observer.waitActionable(page, actionableTargets(scenario), [], timeoutMs);
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
  return { limit, prepared: true };
}

export function actionableTargets(scenario, preparation = false) {
  if (scenario.admin || scenario.sidebarReadiness?.transport !== "navigation-post") return [];
  if (["multiview", "hidden-tab"].includes(scenario.kind)) {
    const indices =
      scenario.kind === "hidden-tab" && !preparation
        ? [0, ...scenario.visibleIndices.slice(1)]
        : scenario.visibleIndices;
    return indices.map((index) => ({
      parent: scenario.sessions[index].sessionId,
      root: `[data-pane-id="perf-pane-${index}"]`,
    }));
  }
  const match = /^\/s\/([^/?#]+)$/.exec(scenario.path);
  if (!match) return [];
  const parent =
    !preparation && scenario.kind === "sidebar-switch" ? scenario.session.sessionId : decodeURIComponent(match[1]);
  assert.ok(typeof parent === "string" && parent.length > 0 && parent.length <= 512);
  return [{ parent, root: ".custom-chat" }];
}

export function actionableRequirements(targets) {
  return targets.map(({ parent }) => ({
    path: "/api/session-navigation/page",
    method: "POST",
    navigation: navigationIntent(
      "/api/session-navigation/page",
      JSON.stringify({ parentSessionId: parent, children: true, actionable: true }),
    ),
    captureActionable: true,
    allowSupersededAbort: true,
  }));
}

async function waitActionableDom(page, target, evidence, requests, timeout) {
  const waiting = evidence.waiting.map(({ pathSha256, idSha256 }) => {
    const response = requests.findLast(
      (entry) =>
        entry.sameOrigin &&
        entry.method === "GET" &&
        sha256(entry.path) === pathSha256 &&
        entry.completed &&
        entry.approvalCount !== undefined,
    );
    assert.ok(response);
    const id = decodeURIComponent(response.path.slice("/api/sessions/".length, -"/approvals".length));
    assert.equal(sha256(id), idSha256);
    return { id, idSha256, count: response.approvalCount };
  });
  const result = await page.waitForFunction(
    ({ target, evidence, waiting }) => {
      const visible = (element) =>
        element.getClientRects().length > 0 &&
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const root = [...globalThis.document.querySelectorAll(target.root)].find(visible);
      if (!root) return false;
      const strips = [...root.querySelectorAll(".subagent-activity")].filter(visible);
      if (evidence.count === 0 && evidence.total === 0 && evidence.nextCursorSha256 === null)
        return strips.length === 0 ? { parent: target.parent, loaded: 0, total: 0, waiting: [] } : false;
      if (strips.length !== 1) return false;
      const strip = strips[0];
      if (
        strip.dataset.parentSessionId !== target.parent ||
        strip.dataset.sessionPageState !== "ready" ||
        strip.getAttribute("aria-busy") !== "false" ||
        strip.dataset.loaded !== String(evidence.count) ||
        strip.dataset.total !== String(evidence.total)
      )
        return false;
      const more = [...strip.querySelectorAll('[data-session-page="subagents"]')].filter(visible);
      if (
        more.length !== Number(Boolean(evidence.nextCursorSha256)) ||
        more.some((element) => element.disabled || element.getAttribute("aria-disabled") === "true")
      )
        return false;
      const rows = [...strip.querySelectorAll(".subagent-row.waiting")].filter(visible);
      if (rows.length !== waiting.length) return false;
      if (
        rows.some((row, index) => {
          if (row.dataset.sessionId !== waiting[index].id) return true;
          const approvals = [...row.querySelectorAll(".composer-approval")];
          return (
            approvals.length !== waiting[index].count ||
            approvals.some((approval) => {
              if (!visible(approval)) return true;
              const buttons = [...approval.querySelectorAll("button.approval-btn")];
              return (
                !buttons.some((button) => button.classList.contains("deny") && button.textContent.trim() === "Deny") ||
                !buttons.some((button) => button.textContent.trim() === "Allow once") ||
                buttons.some(
                  (button) =>
                    !visible(button) ||
                    button.matches(":disabled") ||
                    button.closest('[aria-disabled="true"], [inert]') ||
                    globalThis.getComputedStyle(button).pointerEvents === "none",
                )
              );
            })
          );
        })
      )
        return false;
      return {
        parent: target.parent,
        loaded: evidence.count,
        total: evidence.total,
        waiting: rows.map((row) => ({
          id: row.dataset.sessionId,
          count: row.querySelectorAll(".composer-approval").length,
        })),
      };
    },
    { target, evidence, waiting },
    { timeout },
  );
  const rendered = await result.jsonValue();
  const hashedWaiting = waiting.map(({ idSha256, count }) => ({ idSha256, count }));
  assert.deepEqual(
    rendered.waiting.map(({ id, count }) => ({ idSha256: sha256(id), count })),
    hashedWaiting,
    "Actionable approval rendering differs from completed responses",
  );
  return {
    parentSha256: sha256(rendered.parent),
    pageSha256: sha256(JSON.stringify(evidence)),
    loaded: rendered.loaded,
    total: rendered.total,
    waiting: hashedWaiting,
  };
}

function sidebarRetainedIds(scenario, preparation = false) {
  if (["multiview", "hidden-tab"].includes(scenario.kind)) return scenario.sessions.map((session) => session.sessionId);
  if (preparation && scenario.kind === "sidebar-switch") return [decodeURIComponent(scenario.path.slice(3))];
  return scenario.session ? [scenario.session.sessionId] : [];
}

export function sidebarRequirements(spec, { optional = false, cursorSha256 } = {}) {
  if (spec.transport === "legacy-get")
    return ["/api/sessions", "/api/contexts"].map((path) => ({
      path,
      optional,
      ...(spec.dynamic ? { captureSidebar: true } : {}),
    }));
  assert.equal(spec.transport, "navigation-post");
  const common = {
    path: "/api/session-navigation",
    method: "POST",
    navigation: { surface: spec.surface },
    captureNavigation: true,
    ...(spec.dynamic ? { captureSidebar: true } : {}),
    allowSupersededAbort: true,
    optional,
  };
  return [
    {
      ...common,
      navigation: {
        ...common.navigation,
        section: cursorSha256 ? "recent" : null,
        cursorSha256: cursorSha256 ?? null,
      },
      optional: cursorSha256 ? false : optional,
    },
    common,
  ];
}

export function validateSidebarEvidence(evidence, spec, previousRequests = []) {
  assert.deepEqual(evidence.errors, [], "Browser/request errors occurred before sidebar completion");
  if (spec.dynamic) {
    const entries = [...previousRequests, ...evidence.requests].filter(
      (entry) =>
        entry.sameOrigin &&
        entry.completed &&
        entry.status === 200 &&
        [
          "/api/sessions",
          "/api/contexts",
          "/api/session-navigation",
          "/api/session-navigation/page",
          "/api/session-navigation/resolve",
        ].includes(entry.path),
    );
    assert.ok(entries.length, "Dynamic sidebar needs actual completed response evidence");
    for (const entry of entries)
      validateSidebarCapture(entry, {
        principalId: evidence.identity,
        profile: { transport: spec.transport, sourceRevision: spec.sourceRevision },
      });
    return;
  }
  if (spec.transport === "legacy-get") return;
  assert.equal(
    evidence.requests.some((entry) => entry.sameOrigin && entry.path === "/api/sessions"),
    false,
    "Bounded navigation fell back to the full session list",
  );
  const cursors = new Map([[null, 0]]);
  const allowed = new Set(
    spec.allowedOffPageRows.flatMap((row) => [`id:${sha256(row.id)}`, `thread:${sha256(row.threadRef)}`]),
  );
  for (const entry of [...previousRequests, ...evidence.requests]) {
    if (entry.path !== "/api/session-navigation" || !entry.completed || entry.status !== 200) continue;
    assert.ok(entry.sameOrigin && entry.method === "POST");
    assert.ok(entry.navigationPages, "Missing completed navigation page evidence");
    const intent = entry.navigation;
    assert.equal(intent.surface, spec.surface);
    assert.ok([null, "recent"].includes(intent.section), "Unexpected sidebar pagination section");
    for (const ref of intent.references)
      assert.ok(allowed.has(`${ref.kind}:${ref.valueSha256}`), "Navigation referenced an unobserved session");
    const offset = cursors.get(intent.cursorSha256);
    assert.notEqual(offset, undefined, "Navigation cursor has no verified predecessor");
    assert.equal(intent.section === null, intent.cursorSha256 === null);
    const expected = {
      recent: { rows: spec.recent.allRows.slice(offset, offset + 50), total: spec.recent.total },
      pinned: { rows: spec.pinned.rows, total: spec.pinned.total },
      groups: { rows: spec.groups.items, total: spec.groups.total },
    };
    for (const [section, { rows, total }] of Object.entries(expected)) {
      const actual = entry.navigationPages[section];
      assert.equal(
        actual.idsSha256,
        sha256(JSON.stringify(rows.map((row) => row[section === "groups" ? "scopeId" : "id"]))),
      );
      assert.equal(actual.count, rows.length);
      assert.equal(actual.total, total);
      assert.equal(Boolean(actual.nextCursorSha256), total > (section === "recent" ? offset : 0) + rows.length);
    }
    const next = entry.navigationPages.recent.nextCursorSha256;
    if (next) {
      assert.ok(!cursors.has(next) || cursors.get(next) === offset + 50, "Navigation cursor did not advance");
      cursors.set(next, offset + 50);
    }
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

export function navigationIntent(path, raw) {
  const fields = {
    "/api/session-navigation": ["surface", "section", "cursor", "references"],
    "/api/session-navigation/page": [
      "surface",
      "status",
      "scopeId",
      "parentSessionId",
      "query",
      "title",
      "children",
      "actionable",
      "pinned",
      "archived",
      "cursor",
    ],
    "/api/session-navigation/resolve": ["references"],
  }[path];
  if (!fields) return undefined;
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 65536, "Invalid navigation request body");
  const body = JSON.parse(raw);
  assert.ok(body && typeof body === "object" && !Array.isArray(body), "Invalid navigation request body");
  assert.ok(
    Object.keys(body).every((key) => fields.includes(key)),
    "Unknown navigation request field",
  );
  const intent = {};
  for (const field of fields) {
    const value = body[field];
    if (field === "references") {
      assert.ok(value === undefined || (Array.isArray(value) && value.length <= 12), "Invalid navigation references");
      intent.references = (value ?? []).map((ref) => {
        assert.ok(
          ref && typeof ref === "object" && Object.keys(ref).sort().join() === "kind,value",
          "Invalid navigation reference",
        );
        assert.ok(
          ["id", "thread"].includes(ref.kind) &&
            typeof ref.value === "string" &&
            ref.value.length > 0 &&
            ref.value.length <= (ref.kind === "id" ? 512 : 2048),
          "Invalid navigation reference",
        );
        return { kind: ref.kind, valueSha256: sha256(ref.value) };
      });
    } else if (["children", "actionable", "pinned", "archived"].includes(field)) {
      assert.ok(value === undefined || typeof value === "boolean", "Invalid navigation boolean");
      intent[field] = value ?? null;
    } else if (["surface", "section", "status"].includes(field)) {
      const allowed = {
        surface: ["all", "web", "slack", "core"],
        section: ["recent", "pinned", "groups", "archived"],
        status: ["active", "waiting", "archived"],
      }[field];
      assert.ok(value === undefined || allowed.includes(value), "Invalid navigation selection");
      intent[field] = value ?? null;
    } else {
      assert.ok(
        value === undefined || (typeof value === "string" && value.length <= (field === "cursor" ? 4096 : 512)),
        "Invalid navigation text",
      );
      intent[`${field}Sha256`] = value === undefined ? null : sha256(value);
    }
  }
  return intent;
}

function matchesRequest(entry, requirement) {
  return (
    entry.sameOrigin !== false &&
    entry.path === requirement.path &&
    entry.method === (requirement.method ?? "GET") &&
    (!requirement.navigation ||
      (entry.navigation &&
        Object.entries(requirement.navigation).every(
          ([key, value]) =>
            Object.hasOwn(entry.navigation, key) && JSON.stringify(entry.navigation[key]) === JSON.stringify(value),
        )))
  );
}

function navigationPageEvidence(data) {
  const pages = {};
  for (const section of ["recent", "pinned", "groups"]) {
    const page = data?.[section];
    assert.ok(page && Array.isArray(page.items) && page.items.length <= 50);
    assert.ok(Number.isSafeInteger(page.total) && page.total >= page.items.length);
    assert.ok(
      page.nextCursor === null ||
        (typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 4096),
    );
    const ids = page.items.map((item) => item?.[section === "groups" ? "scopeId" : "id"]);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512));
    assert.equal(new Set(ids).size, ids.length);
    pages[section] = {
      idsSha256: sha256(JSON.stringify(ids)),
      count: ids.length,
      total: page.total,
      nextCursorSha256: page.nextCursor === null ? null : sha256(page.nextCursor),
    };
  }
  return pages;
}

function actionablePageEvidence(data, intent) {
  assert.ok(data && Array.isArray(data.items) && data.items.length <= 50);
  assert.ok(Number.isSafeInteger(data.total) && data.total >= data.items.length);
  assert.ok(
    data.nextCursor === null ||
      (typeof data.nextCursor === "string" &&
        data.nextCursor.length > 0 &&
        data.nextCursor.length <= 4096 &&
        data.items.length === 50),
  );
  if (intent.cursorSha256 === null) assert.equal(Boolean(data.nextCursor), data.total > data.items.length);
  const metadata = data.actionable;
  assert.ok(
    metadata &&
      typeof metadata.parentSessionId === "string" &&
      metadata.parentSessionId.length > 0 &&
      metadata.parentSessionId.length <= 512,
  );
  assert.equal(sha256(metadata.parentSessionId), intent.parentSessionIdSha256);
  assert.ok(
    Array.isArray(metadata.depths) &&
      metadata.depths.length === data.items.length &&
      metadata.depths.every((depth) => Number.isSafeInteger(depth) && depth > 0),
  );
  const ids = data.items.map((row) => row?.id);
  assert.ok(
    ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512 && id !== metadata.parentSessionId),
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Array.isArray(data.contexts) && data.contexts.length <= 51);
  for (const context of data.contexts) {
    assert.ok(
      context && typeof context.scopeId === "string" && ["personal", "channel", "group"].includes(context.kind),
    );
    assert.ok(context.name === null || typeof context.name === "string");
    assert.ok(Number.isSafeInteger(context.sessionCount) && context.sessionCount >= 0);
    assert.ok(context.lastActivityAt === null || Number.isFinite(context.lastActivityAt));
  }
  for (const field of ["active", "waiting", "archived"])
    assert.ok(Number.isSafeInteger(data.statusTotals?.[field]) && data.statusTotals[field] >= 0);
  for (const row of data.items) {
    assert.ok(
      typeof row.scopeId === "string" &&
        typeof row.threadRef === "string" &&
        Number.isFinite(row.createdAt) &&
        ["dm", "channel", "group"].includes(row.type),
    );
    for (const field of ["working", "awaitingInput", "lastTurnFailed"])
      assert.ok(row[field] === undefined || typeof row[field] === "boolean");
    assert.ok(row.working || row.awaitingInput || row.lastTurnFailed);
  }
  if (metadata.parentSubagents === null) assert.equal(data.total, 0);
  else
    for (const field of ["running", "waiting"])
      assert.ok(Number.isSafeInteger(metadata.parentSubagents?.[field]) && metadata.parentSubagents[field] >= 0);
  return {
    parentSha256: sha256(metadata.parentSessionId),
    idsSha256: sha256(JSON.stringify(ids)),
    depthsSha256: sha256(JSON.stringify(metadata.depths)),
    count: ids.length,
    total: data.total,
    nextCursorSha256: data.nextCursor === null ? null : sha256(data.nextCursor),
    parentSubagents:
      metadata.parentSubagents === null
        ? null
        : { running: metadata.parentSubagents.running, waiting: metadata.parentSubagents.waiting },
    waiting: data.items
      .filter((row) => row.awaitingInput)
      .map((row) => ({
        idSha256: sha256(row.id),
        pathSha256: sha256(`/api/sessions/${encodeURIComponent(row.id)}/approvals`),
      })),
  };
}

function supersededSurfaceRefresh(entry, next) {
  const before = entry.sidebarCapture,
    after = next.sidebarCapture;
  if (
    entry.sameOrigin !== true ||
    next.sameOrigin !== true ||
    entry.origin !== next.origin ||
    entry.path !== "/api/session-navigation" ||
    next.path !== entry.path ||
    entry.method !== "POST" ||
    next.method !== entry.method ||
    entry.phase !== "failed" ||
    entry.failure !== "net::ERR_ABORTED" ||
    entry.completed !== false ||
    [entry.status, entry.responseAt, entry.responseBodyBytes, entry.responseBodySha256, entry.sidebarProjection].some(
      (value) => value !== undefined,
    ) ||
    next.phase !== "finished" ||
    next.completed !== true ||
    next.status !== 200 ||
    next.failure ||
    next.envelopeError ||
    !next.sidebarProjection ||
    !before ||
    !after ||
    before.role !== "navigation-refresh" ||
    after.role !== before.role ||
    before.referencesPresent !== true ||
    after.referencesPresent !== true ||
    before.cursorSha256 !== null ||
    after.cursorSha256 !== null ||
    !Number.isSafeInteger(before.generation) ||
    before.generation < 1 ||
    after.generation !== before.generation ||
    !Number.isSafeInteger(before.sequence) ||
    before.sequence < 1 ||
    !Number.isSafeInteger(after.sequence) ||
    after.sequence <= before.sequence ||
    entry.navigation?.surface !== "web" ||
    next.navigation?.surface !== "all" ||
    ![null, "archived"].includes(entry.navigation.section) ||
    entry.navigation.cursorSha256 !== null ||
    JSON.stringify({ ...entry.navigation, surface: "all" }) !== JSON.stringify(next.navigation)
  )
    return false;
  const sections = ["recent", "pinned", "groups", "archived"];
  return [
    [before, "web"],
    [after, "all"],
  ].every(
    ([capture, surface]) =>
      Array.isArray(capture.chains) &&
      capture.chains.length === sections.length &&
      capture.chains.every(
        (chain, index) =>
          chain.section === sections[index] &&
          chain.chainSequence === capture.sequence &&
          chain.keySha256 === sha256(JSON.stringify(["navigation", surface, chain.section])),
      ),
  );
}

function sameSidebarCapture(entry, later) {
  const before = entry.sidebarCapture;
  if (!before) return true;
  const after = later.sidebarCapture;
  if (!after || before.role !== after.role || before.referencesPresent !== after.referencesPresent) return false;
  const bindings = (capture) =>
    capture.chains.map(({ section, keySha256, chainSequence }) => [
      section,
      keySha256,
      before.cursorSha256 ? chainSequence : null,
    ]);
  return JSON.stringify(bindings(before)) === JSON.stringify(bindings(after));
}

function supersededAbort(entry, later) {
  if (later.some((row) => supersededSurfaceRefresh(entry, row))) return true;
  return (
    entry.navigation &&
    entry.phase === "failed" &&
    entry.failure === "net::ERR_ABORTED" &&
    (entry.status === undefined || (entry.status >= 200 && entry.status < 300)) &&
    later.some(
      (row) =>
        matchesRequest(row, { path: entry.path, method: entry.method, navigation: entry.navigation }) &&
        sameSidebarCapture(entry, row) &&
        JSON.stringify(row.navigation) === JSON.stringify(entry.navigation),
    )
  );
}

export function requiredResponsesComplete(requests, requirements) {
  return requirements.every((requirement) => {
    const matching = requests.filter((entry) => matchesRequest(entry, requirement));
    if (requirement.optional === true && matching.length === 0) return true;
    const succeeded = (entry) =>
      entry.completed &&
      (requirement.expectedStatuses
        ? requirement.expectedStatuses.includes(entry.status)
        : entry.status >= 200 && entry.status < 300) &&
      (!requirement.expectedError || entry.expectedErrorMatched === true) &&
      (!requirement.captureNavigation || Boolean(entry.navigationPages)) &&
      (!requirement.captureSidebar || Boolean(entry.sidebarProjection)) &&
      (!requirement.captureActionable || Boolean(entry.actionablePage));
    return (
      matching.length > 0 &&
      matching.every(
        (entry, index) =>
          succeeded(entry) ||
          (requirement.allowSupersededAbort === true &&
            requirement.navigation &&
            supersededAbort(entry, matching.slice(index + 1).filter(succeeded))),
      ) &&
      (!requirement.captureActionable ||
        (matching.some(succeeded) &&
          matching.findLast(succeeded).actionablePage.waiting.every(({ pathSha256 }) => {
            const approvals = requests.filter(
              (entry) => entry.sameOrigin && entry.method === "GET" && sha256(entry.path) === pathSha256,
            );
            return (
              approvals.length > 0 &&
              approvals.every((entry) => entry.completed && entry.status === 200 && entry.approvalCount !== undefined)
            );
          }))) &&
      (!requirement.paginated || matching.some((entry) => entry.finalPage === true)) &&
      (!requirement.settledField || matching.some((entry) => entry.settled === true)) &&
      (!requirement.followupWhenNonempty ||
        (matching.every((entry) => entry.followupRequired !== undefined) &&
          (!matching.some((entry) => entry.followupRequired) ||
            requiredResponsesComplete(requests, [{ path: requirement.followupPath }]))))
    );
  });
}

export function observe(page, origin, requirements, sidebar) {
  const requests = [];
  const errors = [];
  const byRequest = new Map();
  const pending = new Set();
  const changed = new Set();
  const notify = () => {
    for (const listener of changed) listener();
  };
  let identity;
  let identityRead = 0;
  let active = false;
  let generation = 0;
  let contextProjection;
  let contextsReady = Promise.withResolvers();
  let lastSidebar;
  let sidebarVersion = 0;
  let sidebarPhaseGeneration = 0;
  const sidebarRecords = [];
  let sidebarSequence = 0;
  let contextSequence = 0;
  let lastSidebarSequence = 0;
  const sidebarEntries = new Map();
  const sidebarRequests = new Map();
  const activeChains = new Map();
  const bindSidebarRequest = (entry, request) => {
    const body = request.body;
    const sequence = sidebarEntries.get(entry);
    const read = { sequence, request, chains: new Map(), earlier: new Set(), done: Promise.withResolvers() };
    let role = request.path === "/api/sessions" ? "legacy-sessions" : "legacy-contexts";
    const selected = [];
    if (request.path === "/api/session-navigation") {
      const refresh = body.cursor === undefined && (!body.section || Object.hasOwn(body, "references"));
      role = refresh ? "navigation-refresh" : "navigation-section";
      for (const section of refresh ? ["recent", "pinned", "groups", "archived"] : [body.section])
        selected.push([section, JSON.stringify(["navigation", body.surface ?? "all", section])]);
    } else if (request.path === "/api/session-navigation/page") {
      role = "session-page";
      const filters = { ...entry.navigation };
      delete filters.cursorSha256;
      filters.surface ??= "all";
      filters.children ??= false;
      filters.actionable ??= false;
      selected.push(["page", JSON.stringify([role, filters])]);
    } else if (request.path === "/api/session-navigation/resolve") role = "resolve";
    for (const [section, key] of selected) {
      let chain = activeChains.get(key);
      if (body.cursor === undefined) {
        chain = { sequence, key, tokens: new Map(), reads: [] };
        activeChains.set(key, chain);
      }
      read.chains.set(section, chain);
      if (chain) {
        for (const earlier of chain.reads) read.earlier.add(earlier.done.promise);
        chain.reads.push(read);
      }
    }
    sidebarVersion++;
    entry.sidebarCapture = {
      generation,
      sequence,
      role,
      referencesPresent: Boolean(body && Object.hasOwn(body, "references")),
      cursorSha256: body?.cursor === undefined ? null : sha256(body.cursor),
      requestIntentSha256: sha256(JSON.stringify(request)),
      chains: selected.map(([section, key]) => ({
        section,
        keySha256: sha256(key),
        chainSequence: read.chains.get(section)?.sequence ?? null,
      })),
    };
    return read;
  };
  const projectSidebar = async (entry, data, request, observedGeneration, read) => {
    if (request.path === "/api/sessions" && !contextProjection) await contextsReady.promise;
    const chain = read?.chains.get(request.path === "/api/session-navigation" ? request.body?.section : "page");
    const token = request.body?.cursor === undefined ? null : sha256(request.body.cursor);
    const preceding = () => {
      const producer = token ? chain?.tokens.get(token) : null;
      return producer?.sequence < read.sequence ? producer.projection : null;
    };
    if (token && !preceding()) await Promise.all(read.earlier);
    if (generation !== observedGeneration) return;
    const previous = preceding();
    const projection = projectSidebarResponse({
      data,
      responseBody: { bytes: entry.responseBodyBytes, sha256: entry.responseBodySha256 },
      request,
      commonActor: sidebar.commonActor,
      dynamicActor: sidebar.dynamicActor,
      profile: sidebar.profile,
      principalId: sidebar.principalId,
      previous,
      legacySurface: sidebar.surface,
      contextProjection,
    });
    entry.sidebarProjection = retainSidebarProjection(projection, sidebar.retention, entry.responseAt);
    sidebarRecords.push({ entry, projection, request, data, previous });
    pruneSidebarDomRecords(
      sidebarRecords,
      new Map([...activeChains.values()].map((chain) => [sha256(chain.key), chain.sequence])),
      sidebar.surface,
    );
    const sequence = sidebarEntries.get(entry);
    if (request.path === "/api/contexts" && sequence > contextSequence) {
      contextProjection = projection;
      contextSequence = sequence;
      contextsReady.resolve();
    }
    for (const [section, owned] of read?.chains ?? []) {
      const next = projection.sections[section]?.nextCursorSha256;
      if (owned && next && (!owned.tokens.has(next) || sequence < owned.tokens.get(next).sequence))
        owned.tokens.set(next, { sequence, projection });
    }
    if (["/api/sessions", "/api/session-navigation"].includes(request.path) && sequence > lastSidebarSequence) {
      lastSidebar = { projection, request, data, previous };
      lastSidebarSequence = sequence;
    }
    sidebarVersion++;
    notify();
  };
  const currentErrors = () => [
    ...errors,
    ...requests.flatMap((entry, index) => {
      if (
        !entry.envelopeError ||
        (entry.navigation &&
          supersededAbort(
            entry,
            requests
              .slice(index + 1)
              .filter(
                (later) =>
                  later.completed &&
                  later.status === 200 &&
                  (later.actionablePage || later.navigationPages || later.sidebarProjection) &&
                  !later.envelopeError,
              ),
          ))
      )
        return [];
      return [{ type: "contract", path: entry.path, message: entry.envelopeError }];
    }),
  ];
  const sidebarState = () => {
    assert.ok(
      identity === undefined || identity === sidebar.principalId,
      "Sidebar viewer differs from the observed identity",
    );
    const entries = requests.filter((entry) => entry.sidebarCapture);
    const succeeded = (entry) =>
      entry.completed && entry.status === 200 && entry.sidebarProjection && !entry.envelopeError;
    return {
      records: sidebarRecords,
      chains: new Map([...activeChains.values()].map((chain) => [sha256(chain.key), chain.sequence])),
      generation: sidebarPhaseGeneration,
      version: sidebarVersion,
      errors: currentErrors(),
      ready:
        identity === sidebar.principalId &&
        entries.every(
          (entry, index) => succeeded(entry) || supersededAbort(entry, entries.slice(index + 1).filter(succeeded)),
        ),
    };
  };
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
    if (sidebar) sidebarEntries.set(entry, ++sidebarSequence);
    if (entry.sameOrigin && entry.method === "POST" && entry.path.startsWith("/api/session-navigation")) {
      try {
        entry.navigation = navigationIntent(entry.path, request.postData());
        if (sidebar)
          sidebarRequests.set(
            request,
            bindSidebarRequest(entry, {
              method: entry.method,
              path: entry.path,
              body: JSON.parse(request.postData()),
            }),
          );
      } catch {
        errors.push({ type: "contract", path: entry.path, message: "Invalid navigation request intent" });
      }
    }
    if (
      sidebar &&
      entry.sameOrigin &&
      entry.method === "GET" &&
      ["/api/sessions", "/api/contexts"].includes(entry.path)
    )
      sidebarRequests.set(request, bindSidebarRequest(entry, { method: entry.method, path: entry.path }));
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
    sidebarRequests.get(request)?.done.resolve();
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
    let bodyRead;
    const boundedJson = () =>
      (bodyRead ??= (async () => {
        const raw = await response.body();
        if (generation !== observedGeneration) return;
        assert.ok(raw.length > 0 && raw.length <= 4194304, "Response body exceeds the observation bound");
        entry.responseBodyBytes = raw.length;
        entry.responseBodySha256 = sha256(raw);
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      })());
    const capturesSidebar =
      sidebar &&
      entry.sameOrigin &&
      ((entry.method === "GET" && ["/api/sessions", "/api/contexts"].includes(entry.path)) ||
        (entry.method === "POST" &&
          ["/api/session-navigation", "/api/session-navigation/page", "/api/session-navigation/resolve"].includes(
            entry.path,
          )));
    if (capturesSidebar) {
      const read = sidebarRequests.get(request);
      const job = boundedJson()
        .then(async (data) => {
          if (generation !== observedGeneration) return;
          assert.equal(entry.status, 200, "Sidebar response failed");
          assert.ok(read, "Sidebar request intent missing");
          await projectSidebar(entry, data, read.request, observedGeneration, read);
        })
        .catch((error) => {
          if (generation === observedGeneration)
            entry.envelopeError = `Invalid sidebar response: ${plainError(error).message}`;
        });
      pending.add(job);
      void job.finally(() => {
        read?.done.resolve();
        pending.delete(job);
        notify();
      });
    }
    if (entry.sameOrigin && ["/me", "/admin/api/me"].includes(entry.path)) {
      identity = undefined;
      const observedIdentityRead = ++identityRead;
      if (entry.status === 200) {
        const job = response
          .json()
          .then((data) => {
            if (generation !== observedGeneration) return;
            const principal = data?.principal ?? data?.user;
            if (typeof principal !== "string" || !principal.trim()) throw new Error("Invalid identity");
            if (identityRead === observedIdentityRead) identity = principal;
          })
          .catch(() => {
            if (generation === observedGeneration)
              errors.push({ type: "contract", path: entry.path, message: "Invalid identity response" });
          });
        pending.add(job);
        void job.finally(() => pending.delete(job));
      }
    }
    const actionable =
      entry.sameOrigin &&
      entry.path === "/api/session-navigation/page" &&
      entry.method === "POST" &&
      entry.navigation?.actionable === true;
    const approval =
      entry.sameOrigin && entry.method === "GET" && /^\/api\/sessions\/[^/]+\/approvals$/.test(entry.path);
    if (actionable || approval) {
      const job = boundedJson()
        .then((data) => {
          if (generation !== observedGeneration) return;
          if (actionable) {
            assert.equal(entry.navigation.children, true);
            entry.actionablePage = actionablePageEvidence(data, entry.navigation);
          } else {
            assert.ok(Array.isArray(data?.approvals));
            assert.ok(
              data.approvals.every(
                (row) =>
                  typeof row?.requestId === "string" &&
                  row.requestId.length > 0 &&
                  row.requestId.length <= 512 &&
                  typeof row.command === "string",
              ),
            );
            entry.approvalCount = data.approvals.length;
          }
        })
        .catch(() => {
          if (generation === observedGeneration)
            entry.envelopeError = actionable ? "Invalid actionable page envelope" : "Invalid approval envelope";
        });
      pending.add(job);
      void job.finally(() => {
        pending.delete(job);
        notify();
      });
    }
    const requirement = requirements.find((item) => matchesRequest(entry, item));
    if (
      entry.sameOrigin &&
      requirement &&
      (requirement.paginated ||
        requirement.captureNavigation ||
        requirement.settledField ||
        requirement.followupWhenNonempty ||
        requirement.expectedError)
    ) {
      const job = (requirement.captureNavigation ? boundedJson() : response.json())
        .then((data) => {
          if (generation !== observedGeneration) return;
          if (requirement.captureNavigation) {
            try {
              entry.navigationPages = navigationPageEvidence(data);
            } catch {
              entry.envelopeError = "Invalid navigation page envelope";
            }
          }
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
        .catch(() => {
          if (generation === observedGeneration && requirement.captureNavigation)
            entry.envelopeError = "Invalid navigation page envelope";
        })
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
    sidebarSnapshot() {
      let capture = null;
      if (sidebar) {
        const { generation, version, ready, errors } = sidebarState();
        capture = structuredClone({ generation, version, ready, errors });
      }
      return { lastSidebar, contextProjection, version: sidebarVersion, capture };
    },
    async waitSidebar(page, options = {}) {
      assert.ok(sidebar, "Dynamic sidebar capture is not configured");
      return waitSidebarDom(page, sidebarState, sidebar, options);
    },
    async waitResponses(timeoutMs, selected = requirements, previousRequests = []) {
      const complete = () => requiredResponsesComplete([...previousRequests, ...requests], selected);
      if (complete()) return;
      await new Promise((resolve, reject) => {
        const done = () => {
          if (!complete()) return;
          clearTimeout(timer);
          changed.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          changed.delete(done);
          const unfinished = selected.filter(
            (requirement) => !requiredResponsesComplete([...previousRequests, ...requests], [requirement]),
          );
          reject(
            new Error(`Required page requests did not finish: ${unfinished.map((entry) => entry.path).join(", ")}`),
          );
        }, timeoutMs);
        changed.add(done);
        done();
      });
    },
    async waitActionable(page, targets, previousRequests = [], timeoutMs = 15000) {
      if (targets.length === 0) return [];
      const selected = actionableRequirements(targets);
      const previous = previousRequests.filter(
        (entry) =>
          entry.completed && entry.status === 200 && (entry.actionablePage || entry.approvalCount !== undefined),
      );
      const deadline = performance.now() + timeoutMs;
      const remaining = () => {
        const ms = deadline - performance.now();
        assert.ok(ms > 0, "Actionable readiness did not settle");
        return ms;
      };
      for (;;) {
        await this.waitResponses(remaining(), selected, previous);
        assert.deepEqual(currentErrors(), [], "Actionable readiness observed a request error");
        const all = [...previous, ...requests];
        const responses = selected.map((requirement) =>
          all.findLast(
            (entry) =>
              matchesRequest(entry, requirement) && entry.completed && entry.status === 200 && entry.actionablePage,
          ),
        );
        const approvalPaths = new Set(
          responses.flatMap((entry) => entry.actionablePage.waiting.map((row) => row.pathSha256)),
        );
        const involved = (entry) =>
          selected.some((requirement) => matchesRequest(entry, requirement)) ||
          (entry.sameOrigin && entry.method === "GET" && approvalPaths.has(sha256(entry.path)));
        const checked = all.filter(involved);
        const rendered = [];
        for (const [index, target] of targets.entries())
          rendered.push(await waitActionableDom(page, target, responses[index].actionablePage, all, remaining()));
        const current = [...previous, ...requests].filter(involved);
        if (current.length === checked.length && current.every((entry, index) => entry === checked[index])) {
          assert.deepEqual(currentErrors(), [], "Actionable readiness observed a request error");
          return rendered;
        }
      }
    },
    start(nextRequirements = requirements, { reuseIdentity = false } = {}) {
      if (reuseIdentity) assert.ok(typeof identity === "string" && identity, "No verified identity to reuse");
      else identity = undefined;
      requirements = nextRequirements;
      generation++;
      sidebarPhaseGeneration = generation;
      contextsReady.resolve();
      contextsReady = Promise.withResolvers();
      if (!reuseIdentity) {
        contextProjection = undefined;
        lastSidebar = undefined;
        contextSequence = 0;
        lastSidebarSequence = 0;
        activeChains.clear();
        sidebarRecords.length = 0;
      }
      for (const read of sidebarRequests.values()) read.done.resolve();
      sidebarEntries.clear();
      sidebarRequests.clear();
      sidebarVersion++;
      byRequest.clear();
      pending.clear();
      requests.length = 0;
      errors.length = 0;
      active = true;
    },
    async finish(timeoutMs = 15000) {
      assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 0);
      active = false;
      let timer;
      try {
        const settled = await Promise.race([
          Promise.all(pending).then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        if (!settled)
          errors.push({
            type: "observer-timeout",
            message: "Response observation did not finish",
            pendingObservations: pending.size,
          });
      } finally {
        clearTimeout(timer);
        generation++;
        contextsReady.resolve();
        for (const read of sidebarRequests.values()) read.done.resolve();
        pending.clear();
      }
      const now = Date.now();
      for (const entry of requests)
        if (!entry.completed && entry.phase !== "failed") entry.pendingForMs = now - entry.startedAt;
      return structuredClone({ requests, errors: currentErrors(), identity });
    },
  };
}

async function sample(browser, config, scenario, cell, iteration, output, runtimeSidebar) {
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
    const sidebar = scenario.sidebarReadiness;
    if (!scenario.admin) {
      assert.ok(sidebar, "Missing independent sidebar readiness");
      assert.equal(sidebar.sourceRevision, config.sourceRevision, "Sidebar oracle belongs to different source");
      assert.deepEqual(config.sidebarProfile, {
        transport: sidebar.transport,
        sourceRevision: config.sourceRevision,
      });
    }
    let captureSidebar;
    if (sidebar?.dynamic) {
      assert.ok(runtimeSidebar, "Dynamic sidebar runtime input required");
      result.dynamicSidebarSha256 = runtimeSidebar.binding.sha256;
      captureSidebar = {
        commonActor: runtimeSidebar.commonActors[scenario.principalId],
        dynamicActor: runtimeSidebar.data.actors[scenario.principalId],
        profile: runtimeSidebar.data.profile,
        principalId: scenario.principalId,
        surface: sidebar.surface,
        retention: runtimeSidebar.retention,
      };
      assert.ok(captureSidebar.commonActor && captureSidebar.dynamicActor, "Runtime sidebar actor missing");
    }
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
    const common = sidebar ? [{ path: "/me" }, ...sidebarRequirements(sidebar)] : [];
    const preparationRequirements = [...(scenario.kind === "web-overlay" ? [] : scenario.requiredResponses), ...common];
    observer = observe(page, config.baseUrl, preparationRequirements, captureSidebar);
    observer.start();
    const preparation = await prepare(page, scenario, cell.cache, config.baseUrl, observer, config.timeoutMs ?? 15000);
    if (preparation.prepared) {
      await observer.waitResponses(config.timeoutMs ?? 15_000);
      const actionable = await observer.waitActionable(
        page,
        actionableTargets(scenario, true),
        [],
        config.timeoutMs ?? 15000,
      );
      const sidebarState = sidebar
        ? await waitScenarioSidebar(page, scenario, observer, {
            limit: preparation.limit,
            retainedIds: sidebarRetainedIds(scenario, true),
          })
        : undefined;
      result.preparation = {
        ...(await observer.finish(config.timeoutMs ?? 15000)),
        finishedAt: Date.now(),
        sidebar: sidebarState,
        actionable,
      };
      assert.equal(result.preparation.identity, scenario.principalId, "Preparation authenticated the wrong principal");
      assert.deepEqual(result.preparation.errors, [], "Browser/request errors occurred during preparation");
      if (sidebar) validateSidebarEvidence(result.preparation, sidebar);
      if (sidebar?.dynamic) {
        validateSidebarSettled(observer, sidebarState);
        validateSidebarDom(sidebarState, result.preparation.requests, {
          finishedAt: result.preparation.finishedAt,
          principalId: scenario.principalId,
          profile: captureSidebar.profile,
          surface: sidebar.surface,
        });
      }
    }
    const interactive = INTERACTIVE_KINDS.has(scenario.kind);
    let cursorSha256;
    if (scenario.kind === "sidebar-more" && sidebar.transport === "navigation-post") {
      cursorSha256 = result.preparation.requests.findLast(
        (entry) => entry.completed && entry.navigation?.section === null && entry.navigationPages,
      )?.navigationPages.recent.nextCursorSha256;
      assert.match(cursorSha256 ?? "", /^[a-f0-9]{64}$/, "Sidebar page two has no verified continuation");
    }
    const interactiveSidebarRequirements = sidebar
      ? sidebarRequirements(sidebar, { optional: true, cursorSha256 })
      : [];
    const measuredRequirements = [
      ...scenario.requiredResponses,
      ...(interactive ? interactiveSidebarRequirements : common),
    ];
    if (interactive)
      await page.evaluate(() => {
        performance.clearResourceTimings();
        globalThis.__qmPerformance.longTasks = [];
      });
    result.startedAt = Date.now();
    measurementStart = performance.now();
    observer.start(measuredRequirements, { reuseIdentity: interactive });
    await action(page, scenario, cell.cache, config.baseUrl);
    await observer.waitResponses(config.timeoutMs ?? 15_000);
    await waitReady(page, scenario.ready);
    await observer.waitResponses(config.timeoutMs ?? 15_000);
    result.actionable = await observer.waitActionable(
      page,
      actionableTargets(scenario),
      interactive ? result.preparation.requests : [],
      config.timeoutMs ?? 15000,
    );
    if (sidebar)
      result.sidebar = await waitScenarioSidebar(page, scenario, observer, {
        limit: interactive ? preparation.limit + (scenario.kind === "sidebar-more" ? 50 : 0) : 50,
        retainedIds: sidebarRetainedIds(scenario),
      });
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
    const evidence = await observer.finish(config.timeoutMs ?? 15000);
    Object.assign(result, evidence);
    result.requiredResponses = measuredRequirements;
    assert.equal(evidence.identity, scenario.principalId, "Browser is authenticated as the wrong fixture principal");
    assert.deepEqual(evidence.errors, [], "Browser/request errors occurred during measurement");
    if (sidebar) validateSidebarEvidence(evidence, sidebar, interactive ? result.preparation.requests : []);
    if (sidebar?.dynamic) {
      validateSidebarSettled(observer, result.sidebar);
      validateSidebarDom(result.sidebar, [...(interactive ? result.preparation.requests : []), ...evidence.requests], {
        finishedAt: result.finishedAt,
        principalId: scenario.principalId,
        profile: captureSidebar.profile,
        surface: sidebar.surface,
      });
    }
    const actionable = actionableRequirements(actionableTargets(scenario));
    const actionableRequests = [...(interactive ? result.preparation.requests : []), ...evidence.requests];
    assert.ok(requiredResponsesComplete(actionableRequests, actionable), "Actionable requests changed after readiness");
    for (const [index, requirement] of actionable.entries()) {
      const latest = actionableRequests.findLast((entry) => matchesRequest(entry, requirement));
      assert.equal(
        sha256(JSON.stringify(latest.actionablePage)),
        result.actionable[index].pageSha256,
        "Actionable page changed after rendering",
      );
      assert.deepEqual(
        latest.actionablePage.waiting.map(({ idSha256, pathSha256 }) => ({
          idSha256,
          count: actionableRequests.findLast(
            (entry) => entry.sameOrigin && entry.method === "GET" && sha256(entry.path) === pathSha256,
          ).approvalCount,
        })),
        result.actionable[index].waiting,
        "Actionable approvals changed after rendering",
      );
    }
    result.status = "pass";
  } catch (error) {
    result.error = plainError(error);
    if (measurementStart !== undefined && result.durationMs === null)
      result.durationMs = performance.now() - measurementStart;
    result.finishedAt ??= Date.now();
    if (observer) Object.assign(result, await observer.finish(0));
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
  const catalog = buildCatalog(fixture, config.sourceRevision);
  const selected = config.filter ? catalog.filter((scenario) => new RegExp(config.filter).test(scenario.id)) : catalog;
  assert.ok(selected.length, "No catalog scenarios matched");
  if (listOnly) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  if (catalog.some((scenario) => scenario.sidebarReadiness?.dynamic))
    assert.ok(
      typeof config.dynamicSidebarPath === "string" && config.dynamicSidebarPath,
      "Dynamic sidebar runtime path required",
    );
  const runtimeSidebar = catalog.some((scenario) => scenario.sidebarReadiness?.dynamic)
    ? readDynamicSidebar(
        fromConfig(config.dynamicSidebarPath),
        fixtureBytes,
        config.sidebarProfile,
        config.loadCondition,
        fromConfig(config.fixturePath),
      )
    : undefined;
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
    sidebarProfile: config.sidebarProfile,
    ...(runtimeSidebar ? { dynamicSidebar: runtimeSidebar.binding } : {}),
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
  let sampleBytes = 0;
  try {
    for (let iteration = 0; iteration < config.samples; iteration++) {
      for (const cell of shuffle([...cells], (config.orderSeed ?? 7349) + iteration)) {
        const scenario = selected.find((entry) => entry.id === cell.scenarioId);
        const observation = await sample(browser, config, scenario, cell, iteration, output, runtimeSidebar);
        samples.push(observation);
        const line = JSON.stringify(observation) + "\n";
        sampleBytes += Buffer.byteLength(line);
        assert.ok(sampleBytes <= 134217728, "Complete samples exceed the existing native output reader bound");
        appendFileSync(resolve(output, "samples.jsonl"), line);
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
