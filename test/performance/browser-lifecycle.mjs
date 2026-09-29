import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const ownedContexts = new WeakSet();
const usedBackgrounds = new WeakSet();

function installTelemetry() {
  if (globalThis.navigator.serviceWorker)
    globalThis.navigator.serviceWorker.register = async () => {
      globalThis.console.warn("Service Worker registration blocked by Playwright");
    };
  const state = {
    instance: Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4))).join("-"),
    events: [],
    longTasks: [],
    overflow: false,
  };
  const append = (rows, value) => {
    if (rows.length < 512) rows.push(value);
    else state.overflow = true;
  };
  const record = (event) =>
    append(state.events, {
      type: event.type,
      trusted: event.isTrusted,
      at: performance.now(),
      visibility: globalThis.document.visibilityState,
      focused: globalThis.document.hasFocus(),
    });
  for (const name of ["visibilitychange", "freeze", "resume", "click", "keydown", "input"])
    globalThis.document.addEventListener(name, record, true);
  for (const name of ["focus", "blur", "pageshow", "pagehide"]) globalThis.addEventListener(name, record, true);
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      append(state.longTasks, { startTime: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  globalThis.__qmLifecycle = state;
}

function guardOwnedBrowser() {
  const { spawn } = process.getBuiltinModule("node:child_process");
  const { mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const { setTimeout: delay } = process.getBuiltinModule("node:timers/promises");
  let child, profile, closing, startupTimer;
  let stderr = "";
  const alive = () => {
    if (!child?.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "EPERM") return true;
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  };
  const signal = (value) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const close = (failure) =>
    (closing ??= (async () => {
      clearTimeout(startupTimer);
      signal("SIGTERM");
      for (let i = 0; i < 20 && alive(); i++) await delay(100);
      signal("SIGKILL");
      for (let i = 0; i < 30 && alive(); i++) await delay(100);
      if (alive()) throw new Error("Owned Chromium process group survived cleanup");
      if (profile) rmSync(profile, { recursive: true, force: true });
      const result = {
        type: "closed",
        cleanup: { pid: child?.pid, profile, processGroupAbsent: true, profileRemoved: true, stderr },
        error: failure && { message: failure.message, code: failure.code },
      };
      if (process.connected) process.send(result, () => process.exit(failure ? 1 : 0));
      else process.exit(failure ? 1 : 0);
    })().catch((error) => {
      process.stderr.write(String(error));
      process.exit(1);
    }));
  process.once("disconnect", () => close());
  process.once("SIGTERM", () => close());
  process.once("SIGINT", () => close());
  process.on("message", (message) => {
    if (message === "ready") clearTimeout(startupTimer);
    else if (message === "close") close();
  });
  if (!process.connected) return close();
  try {
    const { executablePath, headless, startupTimeoutMs } = JSON.parse(process.argv[1]);
    startupTimer = setTimeout(() => close(new Error("Owned Chromium startup timed out")), startupTimeoutMs);
    profile = mkdtempSync(join(tmpdir(), "qm-lifecycle-"));
    const args = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    child = spawn(executablePath, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16384);
    });
    child.once("error", (error) => close(error));
    child.once("exit", () => close(new Error("Owned Chromium exited")));
    child.once("spawn", () => {
      if (process.connected)
        process.send({ type: "launched", launch: { executablePath, args, pid: child.pid, profile } }, (error) => {
          if (error) close(error);
        });
      else close();
    });
  } catch (error) {
    close(error);
  }
}

export async function launchLifecycleBrowser({
  executablePath = chromium.executablePath(),
  headless = true,
  startupTimeoutMs = 15000,
} = {}) {
  assert.ok(["darwin", "linux"].includes(process.platform), "Owned process-group cleanup requires Unix");
  assert.ok(typeof executablePath === "string" && executablePath && !executablePath.includes("\0"));
  assert.equal(typeof headless, "boolean");
  assert.ok(Number.isSafeInteger(startupTimeoutMs) && startupTimeoutMs >= 1000 && startupTimeoutMs <= 30000);
  const guardian = spawn(
    process.execPath,
    ["-e", `(${guardOwnedBrowser.toString()})()`, JSON.stringify({ executablePath, headless, startupTimeoutMs })],
    { detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let browser, closing, launch, cleanup, failure;
  let stderr = "";
  const launched = Promise.withResolvers();
  const exited = Promise.withResolvers();
  guardian.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-16384);
  });
  guardian.on("message", (message) => {
    if (message.type === "launched") {
      launch = message.launch;
      launched.resolve(launch);
    } else if (message.type === "closed") {
      cleanup = message.cleanup;
      if (message.error) failure = Object.assign(new Error(message.error.message), { code: message.error.code });
      launched.reject(failure ?? new Error("Owned browser closed during startup"));
    }
  });
  guardian.once("error", (error) => {
    failure = error;
    launched.reject(error);
    exited.resolve();
  });
  guardian.once("exit", () => {
    launched.reject(failure ?? new Error(`Owned browser guardian exited during startup: ${stderr}`));
    exited.resolve();
  });
  const close = () =>
    (closing ??= (async () => {
      if (guardian.connected) guardian.send("close", () => {});
      await exited.promise;
      if (browser) {
        for (const context of browser.contexts()) ownedContexts.delete(context);
        await browser.close();
      }
      assert.ok(cleanup, `Owned browser cleanup receipt missing: ${stderr}`);
      return cleanup;
    })());
  const deadline = performance.now() + startupTimeoutMs;
  const startupTimer = setTimeout(() => {
    launched.reject(new Error("Owned browser guardian startup timed out"));
    if (guardian.connected) guardian.send("close", () => {});
  }, startupTimeoutMs);
  try {
    await launched.promise;
    let port;
    while (!port) {
      assert.ok(!cleanup && performance.now() < deadline, "Owned Chromium did not start");
      try {
        const lines = (await readFile(join(launch.profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
        if (/^[1-9]\d*$/.test(lines[0]) && lines[1]?.startsWith("/devtools/browser/")) port = Number(lines[0]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!port) await delay(25);
    }
    assert.ok(port <= 65535);
    const endpoint = `http://127.0.0.1:${port}`;
    browser = await chromium.connectOverCDP(endpoint, {
      noDefaults: true,
      timeout: Math.max(1, deadline - performance.now()),
    });
    assert.equal(browser.contexts().length, 1);
    const context = browser.contexts()[0];
    await context.addInitScript(installTelemetry);
    assert.ok(guardian.connected && !cleanup, "Owned browser exited during startup");
    await new Promise((resolve, reject) => guardian.send("ready", (error) => (error ? reject(error) : resolve())));
    ownedContexts.add(context);
    return {
      browser,
      context,
      close,
      launch: { ...launch, reaperPid: guardian.pid, endpoint, noDefaults: true },
    };
  } catch (error) {
    error.cleanup = await close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
}

export async function configureLifecyclePage(page, { viewport, locale, timezoneId }) {
  assert.ok(ownedContexts.has(page.context()), "Only the owned default context is supported");
  assert.ok(Number.isSafeInteger(viewport?.width) && viewport.width > 0);
  assert.ok(Number.isSafeInteger(viewport?.height) && viewport.height > 0);
  assert.ok(typeof locale === "string" && locale);
  assert.ok(typeof timezoneId === "string" && timezoneId);
  await page.setViewportSize(viewport);
  const session = await page.context().newCDPSession(page);
  const { userAgent } = await session.send("Browser.getVersion");
  await session.send("Network.setUserAgentOverride", { userAgent, acceptLanguage: locale });
  await session.send("Emulation.setLocaleOverride", { locale });
  await session.send("Emulation.setTimezoneOverride", { timezoneId });
  return session;
}

export async function lifecycleSnapshot(page) {
  assert.ok(ownedContexts.has(page.context()), "Only the owned default context is supported");
  const state = await page.evaluate(() => ({
    ...globalThis.__qmLifecycle,
    timeOrigin: performance.timeOrigin,
    wasDiscarded: globalThis.document.wasDiscarded,
    visibility: globalThis.document.visibilityState,
    focused: globalThis.document.hasFocus(),
    now: performance.now(),
  }));
  assert.ok(state.instance && Array.isArray(state.events) && Array.isArray(state.longTasks));
  assert.equal(state.overflow, false, "Lifecycle telemetry exceeded its bounded inventory");
  assert.equal(state.wasDiscarded, false, "Discarded documents require separate coverage");
  return state;
}

function sameDocument(before, after) {
  assert.equal(after.instance, before.instance, "Lifecycle document changed");
  assert.equal(after.timeOrigin, before.timeOrigin, "Lifecycle time origin changed");
  assert.equal(after.wasDiscarded, false);
}

export async function backgroundLifecycle(page, coverPage, timeoutMs = 5000) {
  assert.notEqual(page, coverPage);
  assert.equal(page.context(), coverPage.context());
  const before = await lifecycleSnapshot(page);
  assert.equal(before.visibility, "visible");
  assert.equal(before.focused, true);
  const startedMs = performance.now();
  await coverPage.bringToFront();
  await page.waitForFunction(() => globalThis.document.visibilityState === "hidden", null, {
    timeout: timeoutMs,
    polling: 25,
  });
  const hidden = await lifecycleSnapshot(page);
  sameDocument(before, hidden);
  assert.equal(hidden.focused, false);
  assert.ok(
    hidden.events
      .slice(before.events.length)
      .some((event) => event.type === "visibilitychange" && event.visibility === "hidden" && event.trusted),
  );
  return { before, hidden, startedMs, hiddenMs: performance.now() };
}

export async function foregroundLifecycle(page, background, interact) {
  const startedMs = performance.now();
  assert.ok(ownedContexts.has(page.context()), "Only the owned default context is supported");
  assert.equal(usedBackgrounds.has(background), false, "Background transition already used");
  usedBackgrounds.add(background);
  const hidden = await lifecycleSnapshot(page);
  sameDocument(background.hidden, hidden);
  assert.equal(hidden.visibility, "hidden");
  assert.equal(hidden.focused, false);
  await page.bringToFront();
  await page.waitForFunction(
    () => globalThis.document.visibilityState === "visible" && globalThis.document.hasFocus(),
    null,
    { polling: 25 },
  );
  const interaction = await interact(page);
  await page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
  );
  const finishedMs = performance.now();
  const after = await lifecycleSnapshot(page);
  sameDocument(hidden, after);
  assert.equal(after.visibility, "visible");
  assert.equal(after.focused, true);
  const events = after.events.slice(hidden.events.length);
  for (const type of ["visibilitychange", "focus", "click", "keydown", "input"])
    assert.ok(
      events.some(
        (event) => event.type === type && event.trusted && (type === "focus" || event.visibility === "visible"),
      ),
      `Missing native foreground ${type}: ${JSON.stringify(events.filter((event) => event.type === type))}`,
    );
  return { startedMs, finishedMs, durationMs: finishedMs - startedMs, hidden, after, interaction };
}
