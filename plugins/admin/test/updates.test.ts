import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  FAILURE_TTL_MS,
  SUCCESS_TTL_MS,
  compareVersions,
  createUpdateChecker,
  fetchUpdateStatus,
} from "../src/update-check.ts";

const NOW = Date.parse("2026-09-02T00:00:00.000Z");
const metadata = (latest = "0.2.0") => ({
  "dist-tags": { latest },
  time: {
    "0.1.9": "2026-08-01T00:00:00.000Z",
    "0.2.0": "2026-08-20T00:00:00.000Z",
    "0.3.0": "2026-08-30T00:00:00.000Z",
  },
  versions: { "0.1.9": {}, "0.2.0": {}, "0.3.0": {} },
});

test("admin update version comparison handles patch, major, and prerelease ordering", () => {
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("the registry response becomes a safe update handoff", async () => {
  const status = await fetchUpdateStatus(
    "0.1.9",
    async () => new Response(JSON.stringify(metadata()), { status: 200 }),
    NOW,
  );
  assert.deepEqual(status, {
    currentVersion: "0.1.9",
    latestVersion: "0.2.0",
    newestVersion: "0.2.0",
    updateAvailable: true,
    updateCommand: "npm exec qm -- update --yes --version 0.2.0",
    releaseUrl: "https://github.com/yc-software/qm/releases/tag/v0.2.0",
    releasedAt: "2026-08-20T00:00:00.000Z",
  });
});

test("new releases wait out the dependency cooldown", async () => {
  const status = await fetchUpdateStatus(
    "0.1.9",
    async () => new Response(JSON.stringify(metadata("0.3.0")), { status: 200 }),
    NOW,
  );
  assert.equal(status.latestVersion, "0.2.0");
  assert.equal(status.newestVersion, "0.3.0");
  assert.equal(status.newestAvailableAt, "2026-09-06T00:00:00.000Z");
});

test("a stable release becomes eligible at exactly seven days", async () => {
  const published = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
  const status = await fetchUpdateStatus(
    "0.1.9",
    async () =>
      new Response(
        JSON.stringify({
          "dist-tags": { latest: "0.2.0" },
          time: { "0.1.9": "2026-08-01T00:00:00.000Z", "0.2.0": published },
          versions: { "0.1.9": {}, "0.2.0": {} },
        }),
        { status: 200 },
      ),
    NOW,
  );
  assert.equal(status.latestVersion, "0.2.0");
});

test("deprecated releases are skipped", async () => {
  const status = await fetchUpdateStatus(
    "0.1.9",
    async () =>
      new Response(
        JSON.stringify({
          ...metadata(),
          versions: { "0.1.9": {}, "0.2.0": { deprecated: "pulled" }, "0.3.0": {} },
        }),
        { status: 200 },
      ),
    NOW,
  );
  assert.equal(status.latestVersion, "0.1.9");
  assert.equal(status.updateAvailable, false);
});

test("a prerelease dist-tag never becomes eligible", async () => {
  const status = await fetchUpdateStatus(
    "0.1.9",
    async () =>
      new Response(
        JSON.stringify({
          "dist-tags": { latest: "0.3.0-rc.1" },
          time: {
            "0.1.9": "2026-08-01T00:00:00.000Z",
            "0.2.0": "2026-08-20T00:00:00.000Z",
            "0.3.0-rc.1": "2026-08-30T00:00:00.000Z",
          },
          versions: { "0.1.9": {}, "0.2.0": {}, "0.3.0-rc.1": {} },
        }),
        { status: 200 },
      ),
    NOW,
  );
  assert.equal(status.latestVersion, "0.2.0");
  assert.equal(status.newestVersion, "0.3.0-rc.1");
  assert.equal(status.newestAvailableAt, undefined);
});

test("cached results are refreshed once their TTL expires", async () => {
  let calls = 0;
  let now = NOW;
  let available = false;
  const checker = createUpdateChecker("0.1.9", {
    now: () => now,
    fetcher: async () => {
      calls++;
      return available
        ? new Response(JSON.stringify(metadata()), { status: 200 })
        : new Response("unavailable", { status: 503 });
    },
  });
  assert.equal(await checker(), null);
  now += FAILURE_TTL_MS - 1;
  assert.equal(await checker(), null);
  assert.equal(calls, 1);
  available = true;
  now += 1;
  assert.equal((await checker())?.latestVersion, "0.2.0");
  assert.equal(calls, 2);
  now += SUCCESS_TTL_MS - 1;
  await checker();
  assert.equal(calls, 2);
  now += 1;
  await checker();
  assert.equal(calls, 3);
});

test("concurrent and repeated checks share the cached registry result", async () => {
  let calls = 0;
  let now = NOW;
  const checker = createUpdateChecker("0.1.9", {
    now: () => now,
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify(metadata()), { status: 200 });
    },
  });
  const [first, second] = await Promise.all([checker(), checker()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  now += 60_000;
  assert.deepEqual(await checker(), first);
  assert.equal(calls, 1);
});

test("registry failures degrade quietly and are cached briefly", async () => {
  let calls = 0;
  const checker = createUpdateChecker("0.1.9", {
    fetcher: async () => {
      calls++;
      return new Response("unavailable", { status: 503 });
    },
  });
  assert.equal(await checker(), null);
  assert.equal(await checker(), null);
  assert.equal(calls, 1);
});

test("the admin shell presents browser and command update paths", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="release-alert"[^>]*aria-live="polite"/);
  assert.match(html, /id="release-alert-command"/);
  assert.match(html, /Copy update command/);
  assert.match(html, /id="update-review"/);
  assert.match(html, /Review update/);
  assert.match(html, /loadUpdateAlert/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /result\.data\?\.error === "version_changed"/);
});

function updateUiHarness(result: { ok: boolean; status: number; data: unknown }) {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf("      let releaseStatus = null;");
  const end = html.indexOf('      $("release-alert-action").onclick', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map<string, Record<string, any>>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const classes = new Set<string>(["hidden"]);
      elements.set(id, {
        dataset: {},
        className: "hidden",
        disabled: false,
        href: "",
        textContent: "",
        classList: {
          add: (...names: string[]) => names.forEach((name) => classes.add(name)),
          remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
          toggle: (name: string, force?: boolean) => {
            const present = force === undefined ? !classes.has(name) : force;
            if (present) classes.add(name);
            else classes.delete(name);
            return present;
          },
          contains: (name: string) => classes.has(name),
        },
        removeAttribute: (name: string) => {
          if (name === "data-tone") delete (elements.get(id)!.dataset as Record<string, unknown>).tone;
        },
      });
    }
    return elements.get(id)!;
  };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const context = vm.createContext({
    $: element,
    api: async () => result,
    clearTimeout: () => undefined,
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    Date,
  });
  vm.runInContext(html.slice(start, end), context);
  return { context, element, timers };
}

test("update status polling backs off through transient responses", async () => {
  const idle = updateUiHarness({ ok: false, status: 503, data: null });
  await vm.runInContext("loadUpdateAlert()", idle.context);
  assert.equal(idle.timers.at(-1)?.delay, 60000);

  const active = updateUiHarness({ ok: false, status: 502, data: null });
  vm.runInContext(`releaseStatus = { updater: { job: { state: "running", targetVersion: "0.2.0" } } }`, active.context);
  await vm.runInContext("loadUpdateAlert()", active.context);
  assert.equal(active.timers.at(-1)?.delay, 4000);
  assert.match(active.element("release-alert-detail").textContent, /reconnecting/i);
});

test("update status polling stops for disabled and unauthorized responses", async () => {
  for (const result of [
    { ok: true, status: 204, data: null },
    { ok: false, status: 401, data: { error: "signed_out" } },
    { ok: false, status: 403, data: { error: "forbidden" } },
  ]) {
    const harness = updateUiHarness(result);
    await vm.runInContext("loadUpdateAlert()", harness.context);
    assert.equal(harness.timers.length, 0);
  }
});

test("a failed deployment remains visible after the installed version changes", () => {
  const harness = updateUiHarness({ ok: true, status: 200, data: null });
  vm.runInContext(
    `renderUpdateAlert({
      updateAvailable: false,
      releaseUrl: "https://github.com/yc-software/qm/releases/tag/v0.2.0",
      updater: { job: {
        id: "job-1",
        state: "failed",
        targetVersion: "0.2.0",
        detail: "Deployment failed",
        updatedAt: Date.now()
      } }
    })`,
    harness.context,
  );
  assert.equal(harness.element("release-alert").classList.contains("hidden"), false);
  assert.equal(harness.element("release-alert").dataset.tone, "danger");
  assert.equal(harness.element("release-alert-detail").textContent, "Deployment failed");
});

test("a failed deployment without the browser updater offers the update command", () => {
  const harness = updateUiHarness({ ok: true, status: 200, data: null });
  vm.runInContext(
    `renderUpdateAlert({
      updateAvailable: true,
      updateCommand: "npm exec qm -- update --yes --version 0.2.0",
      releaseUrl: "https://github.com/yc-software/qm/releases/tag/v0.2.0",
      updater: { available: false, job: {
        id: "job-1",
        state: "failed",
        targetVersion: "0.2.0",
        detail: "Workflow cancelled",
        updatedAt: Date.now()
      } }
    })`,
    harness.context,
  );
  assert.equal(harness.element("release-alert").dataset.tone, "danger");
  assert.equal(harness.element("release-alert-action").textContent, "Copy update command");
  assert.equal(harness.element("release-alert-action").classList.contains("hidden"), false);
  assert.equal(harness.element("release-alert-command").textContent, "npm exec qm -- update --yes --version 0.2.0");
  assert.equal(harness.element("release-alert-command").classList.contains("hidden"), false);
});
