import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
const SCRIPTS = fileURLToPath(new URL("../skills-seed/browse/scripts/", import.meta.url));
const openProcesses = new Map<string, Set<ChildProcess>>();
const FIXTURES = fileURLToPath(new URL("./fixtures/browse-lifecycle/", import.meta.url));
type Call = {
  method: string;
  url: string;
  key: string | undefined;
  body: unknown;
};
async function fakeApi(
  billing: {
    status: number;
    body?: unknown;
  },
  patchStatus = 200,
) {
  const calls: Call[] = [];
  const state = { patchStatus, createStatus: 201, lifetimeMinutes: 60, holdPreflight: false };
  const server: Server = createServer((req: IncomingMessage, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const call = {
        method: req.method ?? "",
        url: req.url ?? "",
        key: req.headers["x-browser-use-api-key"] as string | undefined,
        body: text ? JSON.parse(text) : undefined,
      };
      calls.push(call);
      res.setHeader("content-type", "application/json");
      if (call.url === "/api/v2/billing/account") {
        if (state.holdPreflight) return;
        res.statusCode = billing.status;
        res.end(JSON.stringify(billing.body ?? { detail: "nope" }));
      } else if (call.method === "POST" && call.url === "/api/v4/browsers") {
        res.statusCode = state.createStatus;
        const createdAt = Date.now();
        res.end(
          JSON.stringify({
            id: "b1",
            cdpUrl: "ws://fixture.invalid/browser",
            liveUrl: "https://live.test/b1",
            startedAt: new Date(createdAt).toISOString(),
            timeoutAt: Number.isNaN(state.lifetimeMinutes)
              ? null
              : new Date(createdAt + state.lifetimeMinutes * 60_000).toISOString(),
          }),
        );
      } else if (call.method === "PATCH" && call.url.startsWith("/api/v4/browsers/")) {
        res.statusCode = state.patchStatus;
        res.end(JSON.stringify({ id: "b1", status: "stopped" }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return {
    calls,
    state,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.close();
    },
  };
}
function run(args: string[], env: Record<string, string | undefined>, input?: string, timeoutMs = 20000) {
  return new Promise<{
    code: number | null;
    out: Record<string, unknown>;
    child: ChildProcess;
    exited: Promise<number | null>;
  }>((resolve, reject) => {
    const clean = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "BROWSER_USE_API_KEY", "NODE_OPTIONS"])
      delete clean[k];
    const child = spawn(process.execPath, [join(env.FIXTURE_DIR!, "browser.mjs"), ...args], {
      env: { ...clean, ...env },
    });
    const exited = new Promise<number | null>((done) => child.once("close", done));
    if (args[0] === "open") {
      openProcesses.get(env.FIXTURE_DIR!)?.add(child);
      child.once("close", () => openProcesses.get(env.FIXTURE_DIR!)?.delete(child));
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`browser command timed out: ${args[0]}`));
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += c;
      if (args[0] !== "open" || !stdout.includes("\n")) return;
      try {
        const out = JSON.parse(stdout.split("\n")[0]!);
        if (out.ok) {
          clearTimeout(timeout);
          resolve({ code: 0, out, child, exited });
        }
      } catch {
        return;
      }
    });
    child.stdin.end(input ?? "");
    child.on("close", (code) => {
      clearTimeout(timeout);
      const last = stdout.trim().split("\n").at(-1) ?? "{}";
      try {
        resolve({ code, out: JSON.parse(last), child, exited });
      } catch {
        reject(new Error(`invalid browser output (${args[0]}, exit ${code}): ${stdout}\n${stderr}`));
      }
    });
  });
}
function sandbox(
  api: {
    base: string;
  },
  extra: Record<string, string> = {},
  config: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "browse-skill-"));
  openProcesses.set(dir, new Set());
  for (const name of [
    "browser.mjs",
    "browser-client.mjs",
    "browser-errors.mjs",
    "browser-snapshot.mjs",
    "js-runtime.mjs",
  ])
    copyFileSync(join(SCRIPTS, name), join(dir, name));
  for (const name of ["browser-service.mjs", "playwright-runtime.mjs", "playwright.mjs"])
    copyFileSync(join(FIXTURES, name), join(dir, name));
  const events = join(dir, "events.jsonl");
  const disconnect = join(dir, "disconnect");
  writeFileSync(events, "");
  writeFileSync(join(dir, "fixture-config.json"), JSON.stringify({ events, disconnect, ...config }));
  const env = {
    FIXTURE_DIR: dir,
    BROWSER_USE_API_BASE: api.base,
    BROWSER_USE_API_KEY: "bu_test",
    QM_BROWSE_DIR: join(dir, "run"),
    QM_BROWSE_CACHE: join(dir, "cache"),
    ...extra,
  };
  return {
    dir,
    env,
    events: () =>
      readFileSync(events, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    disconnect: () => writeFileSync(disconnect, ""),
    cleanup: () => {
      for (const child of openProcesses.get(dir) ?? []) child.kill("SIGKILL");
      openProcesses.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("preflight explains a missing, rejected, or empty Browser Use key", async () => {
  const cases: Array<
    [
      {
        status: number;
        body?: unknown;
      },
      string | null,
      boolean,
    ]
  > = [
    [{ status: 200, body: { totalCreditsBalanceUsd: 3 } }, null, true],
    [{ status: 401 }, "key_rejected", false],
    [{ status: 403 }, "key_rejected", false],
    [{ status: 402 }, "no_credits", false],
    [{ status: 200, body: { totalCreditsBalanceUsd: 0 } }, "no_credits", false],
  ];
  for (const [billing, reason, ok] of cases) {
    const api = await fakeApi(billing);
    const box = sandbox(api);
    try {
      const { code, out } = await run(["preflight"], box.env);
      assert.equal(out.ok, ok, JSON.stringify(out));
      if (reason) assert.equal(out.reason, reason);
      assert.equal(code, ok ? 0 : 2);
      assert.equal(api.calls[0]?.key, "bu_test");
    } finally {
      api.close();
      box.cleanup();
    }
  }
  const api = await fakeApi({ status: 200 });
  const box = sandbox(api, { BROWSER_USE_API_KEY: "" });
  try {
    const { code, out } = await run(["preflight"], box.env);
    assert.deepEqual([code, out.reason], [2, "missing_key"]);
    assert.equal(api.calls.length, 0);
  } finally {
    api.close();
    box.cleanup();
  }
});
test("open does not create a browser when the account has no credits", async () => {
  const api = await fakeApi({ status: 402 });
  const box = sandbox(api);
  try {
    const { code, out } = await run(["open"], box.env);
    assert.deepEqual([code, out.reason], [2, "no_credits"]);
    assert.ok(!api.calls.some((c) => c.method === "POST"));
  } finally {
    api.close();
    box.cleanup();
  }
});
test("open keeps one page alive across persistent JavaScript calls and stop stops the cloud browser", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await run(["open", "--country", "none", "--profile", "p-1"], box.env);
    assert.equal(opened.out.ok, true, JSON.stringify(opened.out));
    assert.equal(opened.out.liveUrl, "https://live.test/b1");
    const create = api.calls.find((c) => c.method === "POST");
    assert.deepEqual(create?.body, { proxyCountryCode: null, profileId: "p-1", timeout: 60, allowResizing: true });
    const nav = await run(["js", "await tab.goto('https://example.com'); await tab.title()"], box.env);
    assert.equal(nav.out.result, "Fake https://example.com");
    await run(["js", "-"], box.env, "var n = 41; var keptTab = tab");
    const kept = await run(["js", "n + 1"], box.env);
    assert.equal(kept.out.result, "42");
    const keptTab = await run(["js", "await keptTab.url()"], box.env);
    assert.equal(keptTab.out.result, "https://example.com");
    const shot = await run(["screenshot", join(box.dir, "s.png")], box.env);
    assert.equal(shot.out.ok, true);
    assert.equal(readFileSync(join(box.dir, "s.png"), "utf8"), "screenshot:https://example.com");
    const stopped = await run(["stop"], box.env);
    assert.equal(stopped.out.stopped, true);
    const patch = api.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch?.body, { action: "stop" });
    assert.ok(!existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")));
    assert.ok(!existsSync(join(box.env.QM_BROWSE_DIR, "default.json")));
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("an idle browser is stopped by the daemon", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api, { QM_BROWSE_IDLE_MS: "1500" });
  try {
    const opened = await run(["open"], box.env);
    assert.equal(opened.out.ok, true, JSON.stringify(opened.out));
    for (let i = 0; i < 80 && !api.calls.some((c) => c.method === "PATCH"); i++) await sleep(100);
    assert.ok(api.calls.some((c) => c.method === "PATCH" && c.url === "/api/v4/browsers/b1"));
  } finally {
    api.close();
    box.cleanup();
  }
});
test("a failed stop keeps the browser id so a later stop can retry", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } }, 500);
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const first = await run(["stop"], box.env);
    assert.equal(first.code, 1);
    assert.deepEqual([first.out.stopped, first.out.status], [false, 500]);
    assert.ok(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")));
    api.state.patchStatus = 200;
    const retry = await run(["stop"], box.env);
    assert.deepEqual([retry.code, retry.out.stopped], [0, true]);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
  } finally {
    api.close();
    box.cleanup();
  }
});
test("open stops a browser left behind by a dead daemon before creating another", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    mkdirSync(box.env.QM_BROWSE_DIR, { recursive: true });
    writeFileSync(join(box.env.QM_BROWSE_DIR, "default.json"), JSON.stringify({ id: "old" }));
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const order = api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(order.slice(0, 2), ["PATCH /api/v4/browsers/old", "POST /api/v4/browsers"]);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("structured tabs API persists references and rejects missing tabs without losing the session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const created = await run(
      ["js", "var second = await browser.tabs.new(); await second.goto('https://second.test'); second.id"],
      box.env,
    );
    assert.equal(created.out.result, "page-2", JSON.stringify(created.out));
    const retained = await run(["js", "var restored = browser.tabs.get(second.id); await restored.title()"], box.env);
    assert.equal(retained.out.result, "Fake https://second.test");
    assert.equal((await run(["js", "(await browser.tabs.list()).length"], box.env)).out.result, "2");
    assert.equal((await run(["js", "await tab.url()"], box.env)).out.result, "about:blank");
    const missing = await run(["js", "await browser.tabs.get('missing-tab').title()"], box.env);
    assert.equal(missing.code, 1);
    assert.equal(missing.out.ok, false);
    assert.match(String(missing.out.error), /tab|target/i);
    const rejected = await run(["js", "await Promise.reject(new Error('async failure'))"], box.env);
    assert.equal(rejected.out.ok, false);
    assert.match(String(rejected.out.error), /async failure/);
    const thrown = await run(["js", "throw new Error('sync failure')"], box.env);
    assert.equal(thrown.out.ok, false);
    assert.match(String(thrown.out.error), /sync failure/);
    for (const code of [
      "throw 'boom'",
      "await Promise.reject({ code: 42 })",
      "await new Promise((_, reject) => setTimeout(() => reject(new Error('delayed rejection')), 20))",
      "throw null",
      "throw undefined",
      "throw new Error()",
      "throw ''",
    ]) {
      const primitive = await run(["js", code], box.env);
      assert.equal(primitive.code, 1, code);
      assert.equal(primitive.out.ok, false, code);
      assert.ok(primitive.out.error, code);
      assert.equal((await run(["js", "await restored.url()"], box.env)).out.result, "https://second.test", code);
    }
    assert.equal((await run(["js", "null"], box.env)).out.result, "null");
    assert.equal((await run(["js", "undefined"], box.env)).out.result, "undefined");
    const large = await run(["js", "console.log('x'.repeat(20_000)); 'y'.repeat(20_000)"], box.env);
    assert.equal(large.out.ok, true);
    assert.equal(large.out.truncated, true);
    assert.ok(String(large.out.result).length + String(large.out.output).length <= 10_000);
    const unknown = await run(["js", "await restored.notAnOperation()"], box.env);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.out.ok, false);
    assert.equal((await run(["js", "await restored.url()"], box.env)).out.result, "https://second.test");
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("concurrent js calls run sequentially in the persistent runtime", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    assert.equal((await run(["js", "var serial = 0"], box.env)).out.ok, true);
    const first = run(
      [
        "js",
        "await tab.goto('https://serial.test'); await new Promise(resolve => setTimeout(resolve, 400)); serial += 1",
      ],
      box.env,
    );
    for (let i = 0; i < 100 && !box.events().some((c) => c.method === "goto"); i++) await sleep(20);
    assert.ok(
      box.events().some((c) => c.method === "goto"),
      "first call reached the browser",
    );
    const second = run(["js", "serial += 1"], box.env);
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((r) => [r.code, r.out.result]),
      [
        [0, "1"],
        [0, "2"],
      ],
    );
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("a browser service disconnect stops the cloud browser and removes the dead session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    box.disconnect();
    for (let i = 0; i < 100 && existsSync(join(box.env.QM_BROWSE_DIR, "default.json")); i++) await sleep(30);
    assert.ok(api.calls.some((c) => c.method === "PATCH" && c.url === "/api/v4/browsers/b1"));
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")), false);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
    const dead = await run(["js", "await tab.title()"], box.env);
    assert.equal(dead.code, 1);
    assert.equal(dead.out.ok, false);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("concurrent opens create only one cloud browser for a session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await Promise.all([run(["open"], box.env), run(["open"], box.env)]);
    assert.equal(opened.filter((result) => result.out.ok === true).length, 1, JSON.stringify(opened));
    assert.equal(api.calls.filter((call) => call.method === "POST" && call.url === "/api/v4/browsers").length, 1);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("a disconnected queued caller cannot execute later browser actions", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const active = run(
      [
        "js",
        "var cancelledActionRan = false; await tab.goto('https://active.test'); await new Promise(resolve => setTimeout(resolve, 600))",
      ],
      box.env,
    );
    for (let i = 0; i < 100 && !box.events().some((c) => c.method === "goto"); i++) await sleep(10);
    assert.ok(
      box.events().some((c) => c.method === "goto"),
      "first script has started",
    );
    const queued = request({
      socketPath: join(box.env.QM_BROWSE_DIR, "default.sock"),
      path: "/js",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    queued.on("error", () => {});
    await new Promise<void>((resolve) => {
      queued.once("finish", resolve);
      queued.end(JSON.stringify({ code: "cancelledActionRan = true; await tab.goto('https://must-not-run.test')" }));
    });
    await sleep(50);
    queued.destroy();
    assert.equal((await active).out.ok, true);
    assert.equal((await run(["js", "cancelledActionRan"], box.env)).out.result, "false");
    assert.ok(!box.events().some((c) => c.method === "goto" && c.url === "https://must-not-run.test"));
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("stop cancels a never-resolving script without waiting for the JavaScript timeout", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const active = run(
      ["js", "await tab.goto('https://blocked.test'); await new Promise(() => {})", "--timeout-ms", "0"],
      box.env,
    );
    for (let i = 0; i < 100 && !box.events().some((c) => c.method === "goto"); i++) await sleep(10);
    assert.ok(
      box.events().some((c) => c.method === "goto"),
      "blocked script has started",
    );
    const stopped = await run(["stop"], box.env, undefined, 3000);
    assert.equal(stopped.out.stopped, true, JSON.stringify(stopped.out));
    assert.equal((await active).code, 1, "stopping ends the pending script rather than claiming success");
    assert.ok(api.calls.some((c) => c.method === "PATCH" && c.url === "/api/v4/browsers/b1"));
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")), false);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});
test("screenshot follows the current REPL tab even after the original tab closes", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    assert.equal(
      (await run(["js", "var original = tab; tab = await browser.tabs.new('https://current.test'); tab.id"], box.env))
        .out.result,
      "page-2",
    );
    const path = join(box.dir, "current.png");
    assert.equal((await run(["screenshot", path], box.env)).out.ok, true);
    assert.equal((await run(["js", "await original.close()"], box.env)).out.ok, true);
    assert.equal((await run(["screenshot", path], box.env)).out.ok, true);
    assert.equal(readFileSync(path, "utf8"), "screenshot:https://current.test");
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("a failed browser create returns provider status without leaving a session", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    for (const status of [402, 503]) {
      api.state.createStatus = status;
      const opened = await run(["open"], box.env);
      assert.deepEqual(
        [opened.code, opened.out.reason, opened.out.status],
        [status === 402 ? 2 : 1, "create_failed", status],
      );
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.lock")), false);
    }
    assert.equal(
      api.calls.some((call) => call.method === "PATCH"),
      false,
    );
  } finally {
    api.close();
    box.cleanup();
  }
});

test("service and worker initialization failures stop the allocated cloud browser", async () => {
  for (const config of [{ serviceError: "service could not connect" }, { connectError: "worker could not connect" }]) {
    const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
    const box = sandbox(api, {}, config);
    try {
      const opened = await run(["open"], box.env);
      assert.deepEqual([opened.code, opened.out.reason], [1, "connect_failed"]);
      assert.match(String(opened.out.error), config.serviceError ? /service could not connect/ : /client exited/);
      assert.ok(api.calls.some((call) => call.method === "PATCH" && call.url === "/api/v4/browsers/b1"));
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")), false);
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.lock")), false);
      if (config.connectError) assert.ok(box.events().some((event) => event.method === "service.close"));
    } finally {
      await run(["stop"], box.env).catch(() => {});
      api.close();
      box.cleanup();
    }
  }
});

test("a stale browser must be stopped successfully before a replacement is allocated", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } }, 500);
  const box = sandbox(api);
  try {
    mkdirSync(box.env.QM_BROWSE_DIR, { recursive: true });
    const statePath = join(box.env.QM_BROWSE_DIR, "default.json");
    writeFileSync(statePath, JSON.stringify({ id: "old" }));
    const opened = await run(["open"], box.env);
    assert.deepEqual([opened.code, opened.out.reason, opened.out.browserId], [1, "stale_browser_not_stopped", "old"]);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).id, "old");
    assert.equal(
      api.calls.some((call) => call.method === "POST"),
      false,
    );
    api.state.patchStatus = 200;
    assert.equal((await run(["stop"], box.env)).out.stopped, true);
  } finally {
    api.close();
    box.cleanup();
  }
});

test("an explicit JavaScript deadline stops the session and reports the timeout", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    const expired = await run(["js", "await new Promise(() => {})", "--timeout-ms", "50"], box.env);
    assert.equal(expired.code, 1);
    assert.match(String(expired.out.error), /JavaScript exceeded/);
    for (let i = 0; i < 100 && existsSync(join(box.env.QM_BROWSE_DIR, "default.json")); i++) await sleep(20);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
    assert.ok(api.calls.some((call) => call.method === "PATCH"));
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("open rejects an already-open session promptly while long JavaScript keeps running", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  let active: ReturnType<typeof run> | undefined;
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    active = run(
      [
        "js",
        "await tab.goto('https://busy.test'); await new Promise(resolve => setTimeout(resolve, 6500)); 'original completed'",
      ],
      box.env,
    );
    for (let i = 0; i < 100 && !box.events().some((event) => event.url === "https://busy.test"); i++) await sleep(10);
    assert.ok(
      box.events().some((event) => event.url === "https://busy.test"),
      "long-running script has started",
    );
    const started = performance.now();
    const reopened = await run(["open"], box.env);
    assert.ok(performance.now() - started < 2000, "health must not wait for the active JavaScript call");
    assert.equal(reopened.code, 1);
    assert.equal(reopened.out.ok, false);
    assert.match(String(reopened.out.error), /already open/);
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(api.calls.filter((call) => call.method === "PATCH").length, 0);
    const completed = await active;
    assert.deepEqual([completed.code, completed.out.result], [0, "original completed"]);
    assert.equal((await run(["js", "tab.url()"], box.env)).out.result, "https://busy.test");
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(api.calls.filter((call) => call.method === "PATCH").length, 0);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    await active?.catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("an unanswered or reset health request cannot replace a possibly live browser", async () => {
  for (const reset of [false, true]) {
    const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
    const box = sandbox(api);
    api.state.createStatus = 503;
    const paths: string[] = [];
    const daemon = createServer((req) => {
      paths.push(req.url ?? "");
      req.resume();
      if (reset) req.socket.destroy();
    });
    try {
      mkdirSync(box.env.QM_BROWSE_DIR, { recursive: true });
      const statePath = join(box.env.QM_BROWSE_DIR, "default.json");
      const state = JSON.stringify({ id: "possibly-live", cdpUrl: "ws://fixture.invalid/browser" });
      writeFileSync(statePath, state);
      const socketPath = join(box.env.QM_BROWSE_DIR, "default.sock");
      daemon.listen(socketPath);
      await new Promise<void>((resolve) => daemon.once("listening", resolve));
      const reopened = await run(["open"], box.env);
      assert.equal(reopened.code, 1, JSON.stringify(reopened.out));
      assert.equal(reopened.out.ok, false);
      assert.deepEqual(paths, ["/health"]);
      assert.equal(
        api.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
        false,
      );
      assert.equal(readFileSync(statePath, "utf8"), state);
      assert.equal(existsSync(socketPath), true);
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.lock")), false);
    } finally {
      daemon.closeAllConnections();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      api.close();
      box.cleanup();
    }
  }
});

test("a late asynchronous error stops the runtime without attributing earlier results to queued scripts", async () => {
  for (const failure of ["throw new Error('late throw')", "Promise.reject(new Error('late rejection'))"]) {
    const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
    const box = sandbox(api);
    const pending: Array<ReturnType<typeof run>> = [];
    try {
      assert.equal((await run(["open"], box.env)).out.ok, true);
      const armed = await run(["js", `setTimeout(() => { ${failure} }, 1000); 'armed'`], box.env);
      assert.deepEqual([armed.code, armed.out.result], [0, "armed"]);
      const second = run(
        [
          "js",
          "await tab.goto('https://second-running.test'); await new Promise(resolve => setTimeout(resolve, 1500)); 'second result'",
        ],
        box.env,
      );
      pending.push(second);
      for (let i = 0; i < 100 && !box.events().some((event) => event.url === "https://second-running.test"); i++)
        await sleep(10);
      assert.ok(
        box.events().some((event) => event.url === "https://second-running.test"),
        "second script has started",
      );
      const third = run(
        [
          "js",
          "await tab.goto('https://must-not-run.test'); await new Promise(resolve => setTimeout(resolve, 2000)); 'third result'",
        ],
        box.env,
      );
      pending.push(third);
      const results = await Promise.all(pending);
      for (const result of results) {
        assert.equal(result.code, 1, JSON.stringify(result.out));
        assert.equal(result.out.ok, false);
        assert.equal(result.out.result, undefined, "no script may receive another script's successful result");
      }
      assert.equal(
        box.events().some((event) => event.url === "https://must-not-run.test"),
        false,
      );
      for (let i = 0; i < 100 && existsSync(join(box.env.QM_BROWSE_DIR, "default.json")); i++) await sleep(20);
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
      assert.ok(api.calls.some((call) => call.method === "PATCH"));
      assert.equal((await run(["js", "'must stay stopped'"], box.env)).code, 1);
    } finally {
      await run(["stop"], box.env).catch(() => {});
      await Promise.allSettled(pending);
      api.close();
      box.cleanup();
    }
  }
});

test("a late asynchronous error with no active script stops the session rather than being ignored", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    assert.equal((await run(["open"], box.env)).out.ok, true);
    assert.equal(
      (await run(["js", "setTimeout(() => { throw new Error('idle late error'); }, 200); 'armed'"], box.env)).out
        .result,
      "armed",
    );
    for (let i = 0; i < 100 && existsSync(join(box.env.QM_BROWSE_DIR, "default.json")); i++) await sleep(20);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
    assert.ok(api.calls.some((call) => call.method === "PATCH"));
    assert.equal((await run(["js", "'must stay stopped'"], box.env)).code, 1);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("open stays foreground after readiness and exits when stop completes", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await run(["open"], box.env);
    assert.equal(opened.out.ok, true);
    await sleep(100);
    assert.equal(opened.child.exitCode, null);
    assert.equal(opened.child.signalCode, null);
    assert.equal(
      api.calls.some((call) => call.method === "PATCH"),
      false,
    );
    assert.deepEqual(api.calls.find((call) => call.method === "POST")?.body, {
      proxyCountryCode: "us",
      timeout: 60,
      allowResizing: true,
    });
    const state = JSON.parse(readFileSync(join(box.env.QM_BROWSE_DIR, "default.json"), "utf8"));
    assert.equal(opened.out.timeoutAt, state.timeoutAt);
    assert.equal(Date.parse(state.timeoutAt) - Date.parse(state.startedAt), 60 * 60_000);
    assert.equal((await run(["stop"], box.env)).out.stopped, true);
    const exited = await Promise.race([opened.exited, sleep(2000).then(() => "still running")]);
    assert.equal(exited, 0);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("terminating the foreground open process stops its cloud browser", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  try {
    const opened = await run(["open"], box.env);
    assert.equal(opened.out.ok, true);
    opened.child.kill("SIGTERM");
    const exited = await Promise.race([opened.exited, sleep(2000).then(() => "still running")]);
    assert.equal(exited, 0);
    assert.ok(api.calls.some((call) => call.method === "PATCH" && call.url === "/api/v4/browsers/b1"));
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
    assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.sock")), false);
  } finally {
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("open stops allocations whose provider deadline does not confirm the lifetime cap", async () => {
  for (const lifetimeMinutes of [0, 61, Number.NaN]) {
    const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
    const box = sandbox(api);
    api.state.lifetimeMinutes = lifetimeMinutes;
    try {
      const opened = await run(["open"], box.env);
      assert.equal(opened.out.ok, false);
      assert.match(String(opened.out.error), /lifetime bounded to 60 minutes/);
      assert.ok(api.calls.some((call) => call.method === "PATCH" && call.url === "/api/v4/browsers/b1"));
      assert.equal(existsSync(join(box.env.QM_BROWSE_DIR, "default.json")), false);
    } finally {
      api.close();
      box.cleanup();
    }
  }
});

test("legacy empty and invalid PID lock files cannot wedge browser startup", async () => {
  for (const contents of ["", "not-a-pid", "0", "-1"]) {
    const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
    const box = sandbox(api);
    try {
      mkdirSync(box.env.QM_BROWSE_DIR, { recursive: true });
      const legacyLock = join(box.env.QM_BROWSE_DIR, "default.lock");
      writeFileSync(legacyLock, contents);
      const opened = await run(["open"], box.env);
      assert.equal(opened.out.ok, true, JSON.stringify(opened.out));
      assert.equal(readFileSync(legacyLock, "utf8"), contents, "legacy PID files are not reinterpreted or removed");
      assert.equal(api.calls.filter((call) => call.method === "POST").length, 1);
    } finally {
      await run(["stop"], box.env).catch(() => {});
      api.close();
      box.cleanup();
    }
  }
});

test("startup ownership excludes contenders and releases automatically when the initializer is killed", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api);
  api.state.holdPreflight = true;
  const initializing = run(["open"], box.env).catch((error: unknown) => error);
  try {
    for (let i = 0; i < 200 && !api.calls.length; i++) await sleep(10);
    assert.equal(api.calls.length, 1, "first initializer reached the held preflight");
    const alias = join(box.env.FIXTURE_DIR, "same-directory");
    symlinkSync(box.env.QM_BROWSE_DIR, alias);
    const contender = await run(["open"], { ...box.env, QM_BROWSE_DIR: alias });
    assert.equal(contender.code, 1);
    assert.match(String(contender.out.error), /is opening/);
    assert.equal(api.calls.length, 1, "contender never reached the provider");
    const owner = [...(openProcesses.get(box.env.FIXTURE_DIR) ?? [])][0];
    assert.ok(owner, "the initializer is still running");
    owner.kill("SIGKILL");
    await initializing;
    api.state.holdPreflight = false;
    const replacement = await run(["open"], box.env);
    assert.equal(replacement.out.ok, true, JSON.stringify(replacement.out));
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    api.state.holdPreflight = false;
    for (const child of openProcesses.get(box.env.FIXTURE_DIR) ?? []) child.kill("SIGTERM");
    await initializing;
    await run(["stop"], box.env).catch(() => {});
    api.close();
    box.cleanup();
  }
});

test("post-start transport failure reaches the pending script and shutdown log without private connection values", async () => {
  const api = await fakeApi({ status: 200, body: { totalCreditsBalanceUsd: 1 } });
  const box = sandbox(api, {}, { disconnectError: "malformed upstream frame" });
  let pending: ReturnType<typeof run> | undefined;
  try {
    const opened = await run(["open"], box.env);
    assert.equal(opened.out.ok, true);
    let log = "";
    opened.child.stderr?.on("data", (chunk) => (log += chunk.toString()));
    pending = run(["js", "await tab.goto('https://pending.test'); await new Promise(() => {})"], box.env);
    for (let i = 0; i < 100 && !box.events().some((event) => event.url === "https://pending.test"); i++)
      await sleep(10);
    assert.ok(box.events().some((event) => event.url === "https://pending.test"));
    box.disconnect();
    const result = await pending;
    assert.equal(result.code, 1);
    assert.equal(await Promise.race([opened.exited, sleep(2000).then(() => "still running")]), 0);
    for (const text of [String(result.out.error), log]) {
      assert.match(text, /WS_ERR_INVALID_OPCODE/);
      assert.match(text, /inner wire failure/);
      assert.equal(text.includes("fixture.invalid"), false);
      assert.equal(text.includes("bu_test"), false);
    }
    assert.ok(api.calls.some((call) => call.method === "PATCH"));
  } finally {
    await run(["stop"], box.env).catch(() => {});
    if (pending) await pending;
    api.close();
    box.cleanup();
  }
});
