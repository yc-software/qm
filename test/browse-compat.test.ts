import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
const endpoint = process.env.BROWSE_TEST_CDP;
const load = (name: string) => import(new URL(`../skills-seed/browse/scripts/${name}`, import.meta.url).href);
test(
  "native Playwright console compatibility through the bound service",
  { skip: !endpoint, timeout: 90000 },
  async (t) => {
    const { ensurePlaywright } = await load("playwright-runtime.mjs");
    const modulePath = await ensurePlaywright();
    const { chromium } = await import(pathToFileURL(modulePath).href);
    const daemon = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const cleanup: (() => unknown)[] = [() => daemon.close()];
    t.after(async () => {
      for (const dispose of cleanup.reverse()) await dispose();
    });
    if (process.env.BROWSE_COMPAT_DROP_RUNTIME) {
      const server = daemon._connection.toImpl(daemon);
      const transport = server._connection._transport;
      const receive = transport.onmessage;
      transport.onmessage = (message: any) => {
        if (message.method !== "Runtime.consoleAPICalled") receive(message);
      };
    }
    const before = await daemon.contexts()[0].newPage();
    let baselineSucceeded = false;
    try {
      await before.locator("html").waitFor({ state: "attached", timeout: 6000 });
      try {
        await before.setContent("<title>baseline</title>", { timeout: 1000 });
        baselineSucceeded = true;
      } catch (error: any) {
        assert.match(error.message, /Timeout/);
        assert.equal(await before.title(), "baseline");
      }
    } finally {
      await before.close();
    }
    const { installBrowserCompatibility } = await load("browser-compat.mjs");
    await t.test("probe preserves its failure and attempts both cleanup operations", async (t) => {
      const context = daemon.contexts()[0];
      const probe = await context.newPage();
      const session = await context.newCDPSession(probe);
      const primary = new Error("console probe failed");
      const detachFailure = new Error("probe detach failed");
      const closeFailure = new Error("probe close failed");
      const send = session.send.bind(session);
      const detach = session.detach.bind(session);
      const close = probe.close.bind(probe);
      t.mock.method(context, "newPage", async () => probe);
      t.mock.method(context, "newCDPSession", async () => session);
      t.mock.method(session, "send", async (method: string, params: unknown) => {
        if (method === "Runtime.evaluate") throw primary;
        return send(method, params);
      });
      t.mock.method(session, "detach", async () => {
        await detach();
        throw detachFailure;
      });
      t.mock.method(probe, "close", async () => {
        await close();
        throw closeFailure;
      });
      await assert.rejects(installBrowserCompatibility(daemon, modulePath), (error: AggregateError) => {
        assert.deepEqual(error.errors, [primary, detachFailure, closeFailure]);
        return true;
      });
      assert.equal(probe.isClosed(), true);
    });
    const compatibility = await installBrowserCompatibility(daemon, modulePath);
    cleanup.push(() => compatibility.dispose());
    assert.equal(compatibility.consoleArguments, baselineSucceeded);
    const { endpoint: bound } = await daemon.bind("compatibility-test", { host: "127.0.0.1", port: 0 });
    cleanup.push(() => daemon.unbind());
    const worker = await chromium.connect(bound);
    cleanup.push(() => worker.close());
    const context = await worker.newContext();
    cleanup.push(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const events: any[] = [];
    page.on("console", (message: any) => events.push(message));
    await t.test("repeated native setContent preserves lifecycle and hides internal tags", async () => {
      for (let n = 0; n < 3; n++) {
        await page.setContent(
          `<title>content ${n}</title><button>Ready</button><iframe srcdoc="<p>Child</p>"></iframe>`,
        );
        assert.equal(await page.title(), `content ${n}`);
        assert.equal(await page.getByRole("button").innerText(), "Ready");
        await page.frames()[1].setContent(`<p>Frame ${n}</p>`, { waitUntil: "domcontentloaded" });
        assert.equal(await page.frames()[1].locator("p").innerText(), `Frame ${n}`);
      }
      assert.ok(events.every((message) => !message.text().includes("--playwright--set--content--")));
    });
    await t.test("console text and source location come from Chromium", async () => {
      events.length = 0;
      await page.setContent('<script>console.log("inline first");\nconsole.warn("inline warning");</script>');
      await page.evaluate(() => {
        const circular: any = { value: 42 };
        circular.self = circular;
        console.log("typed", 42, circular);
      });
      assert.equal(events[0].text(), "inline first");
      assert.equal(events[1].text(), "inline warning");
      assert.equal(events[1].type(), "warning");
      assert.equal(events[1].location().lineNumber, 1);
      const typed = events.find((message) => message.text().startsWith("typed"));
      assert.ok(typed);
      if (compatibility.consoleArguments) {
        assert.equal(await typed.args()[1].jsonValue(), 42);
        assert.equal(await typed.args()[2].evaluate((value: any) => value.self === value), true);
      } else {
        assert.equal(compatibility.consoleSource, "Console.messageAdded");
        assert.equal(compatibility.consoleType, "severity");
        assert.equal(compatibility.consoleTimestamp, "received");
        assert.deepEqual(typed.args(), []);
        assert.equal(typed.text(), "typed 42 [object Object]");
      }
    });
    await t.test("native load waiting still waits for resources", async () => {
      let release!: () => void;
      let observed!: () => void;
      const requestSeen = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      await context.route("https://compat.test/delay.js", async (route: any) => {
        observed();
        await released;
        await route.fulfill({ contentType: "application/javascript", body: "window.loaded = true" });
      });
      let completed = false;
      const loading = page.setContent('<script src="https://compat.test/delay.js"></script>').then(() => {
        completed = true;
      });
      await requestSeen;
      assert.equal(completed, false);
      release();
      await loading;
      assert.equal(await page.evaluate("window.loaded"), true);
      await context.unroute("https://compat.test/delay.js");
    });
    await t.test("cross-site frames and new popup sessions receive the adapter", async () => {
      await context.route("https://compat-cross.test/**", (route: any) =>
        route.fulfill({ contentType: "text/html", body: "<p>cross site</p>" }),
      );
      await page.setContent('<iframe src="https://compat-cross.test/frame"></iframe>');
      const frame = page.frames().find((candidate: any) => candidate.url() === "https://compat-cross.test/frame");
      assert.ok(frame);
      await frame.setContent("<h1>Replaced cross site</h1>");
      assert.equal(await frame.locator("h1").innerText(), "Replaced cross site");
      const opened = context.waitForEvent("page");
      await page.evaluate("window.open('about:blank')");
      const popup = await opened;
      await popup.setContent("<h1>Popup</h1>");
      assert.equal(await popup.locator("h1").innerText(), "Popup");
      await popup.close();
      await context.unroute("https://compat-cross.test/**");
    });
    await t.test("frame timeouts and subsequent content replacement stay native", async () => {
      const pending: any[] = [];
      await context.route("https://compat.test/hang.png", (route: any) => {
        pending.push(route);
      });
      await assert.rejects(page.setContent('<img src="https://compat.test/hang.png">', { timeout: 500 }), /Timeout/);
      for (const route of pending) await route.abort();
      await context.unroute("https://compat.test/hang.png");
      await page.setContent("<h1>Recovered</h1>");
      assert.equal(await page.locator("h1").innerText(), "Recovered");
      assert.ok(events.every((message) => !message.text().includes("--playwright--set--content--")));
    });
  },
);
