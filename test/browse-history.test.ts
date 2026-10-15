import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { installBrowserHistory, restoreBrowserHistory } = await import(
  new URL("../skills-seed/browse/scripts/browser-history.mjs", import.meta.url).href
);

test("history adapter rejects unverified upstream versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-history-test-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.0.0" }));
    await assert.rejects(installBrowserHistory({}, join(dir, "index.mjs")), /pinned Playwright/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("history restoration cancels without changing frames after another navigation", async () => {
  const commands: string[] = [];
  const server = {
    _session: {
      async send(method: string) {
        commands.push(method);
        return { targetInfos: [] };
      },
    },
  };
  const page = { _targetId: "main", _sessions: new Map([["main", {}]]) };
  await restoreBrowserHistory(server, page, () => false);
  assert.deepEqual(commands, ["Target.getTargets"]);
});

test("history restoration waits for descendants and replays native frame, context and load state", async () => {
  const calls: string[] = [];
  const frames = new Map<string, { _currentDocument: { documentId: string } }>([
    ["main", { _currentDocument: { documentId: "root-doc" } }],
  ]);
  const makeSession = (id: string, parentId?: string) => ({
    _targetId: id,
    _contextIdToContext: new Map(),
    _isMainFrame: () => id === "main",
    _client: {
      async send(method: string, params?: { enabled: boolean }) {
        calls.push(`${id}:${method}${params ? `:${params.enabled}` : ""}`);
        return { frameTree: { frame: { id, parentId, loaderId: `${id === "main" ? "root" : id}-doc` } } };
      },
    },
    _handleFrameTree(tree: { frame: { id: string; loaderId: string } }) {
      calls.push(`${id}:restore`);
      frames.set(tree.frame.id, { _currentDocument: { documentId: tree.frame.loaderId } });
    },
  });
  const main = makeSession("main");
  const child = makeSession("child", "main");
  const server = {
    _session: {
      async send() {
        return {
          targetInfos: [
            { targetId: "child", parentId: "main", type: "iframe" },
            { targetId: "unrelated", parentId: "other-page", type: "iframe" },
          ],
        };
      },
    },
  };
  const page = {
    _targetId: "main",
    _sessions: new Map([
      ["main", main],
      ["child", child],
    ]),
    _page: {
      mainFrame: () => frames.get("main"),
      frameManager: {
        frame: (id: string) => frames.get(id),
        removeChildFramesRecursively() {
          calls.push("clear-children");
        },
        frameAttached(id: string) {
          frames.set(id, { _currentDocument: { documentId: "" } });
        },
      },
    },
  };
  await restoreBrowserHistory(server, page, () => true);
  assert.equal(frames.get("child")?._currentDocument.documentId, "child-doc");
  assert(!calls.includes("main:restore"), "does not emit a duplicate main-frame navigation");
  assert(calls.indexOf("child:restore") < calls.indexOf("main:Runtime.disable"));
  assert(calls.indexOf("child:Runtime.enable") < calls.indexOf("main:Page.setLifecycleEventsEnabled:false"));
  assert.equal(calls.at(-1), "child:Page.setLifecycleEventsEnabled:true");
});

test(
  "real BFCache back/forward restores all nested frames and native load waits",
  { skip: !process.env.BROWSE_HISTORY_CDP, timeout: 45000 },
  async () => {
    const { startFixture } = await import(new URL("./fixtures/browse-parity.mjs", import.meta.url).href);
    const { domSnapshot } = await import(
      new URL("../skills-seed/browse/scripts/browser-snapshot.mjs", import.meta.url).href
    );
    const { startBrowserService } = await import(
      new URL("../skills-seed/browse/scripts/browser-service.mjs", import.meta.url).href
    );
    const fixture = await startFixture();
    const service = await startBrowserService(process.env.BROWSE_HISTORY_CDP);
    let browser;
    try {
      const { chromium } = await import(service.modulePath);
      browser = await chromium.connect(service.endpoint);
      const context = await browser.newContext();
      const early = await context.newPage();
      await early.goto(fixture.mainUrl);
      await early.close();
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(fixture.mainUrl);
      await page.ariaSnapshotJSON({ mode: "ai" });
      await page.evaluate("document.body._ariaRef={siteOwned:true}");
      await page.evaluate(
        "window.restored=false;window.addEventListener('pageshow',event=>window.restored=event.persisted)",
      );
      const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("#popup-link").click()]);
      await popup.waitForLoadState();
      await popup.close();
      await Promise.all([page.waitForURL("**/navigation?step=arrived"), page.locator("#navigate").click()]);
      let mainNavigations = 0;
      page.on("framenavigated", (frame: unknown) => {
        if (frame === page.mainFrame()) mainNavigations++;
      });
      await page.goBack();
      assert.equal(await page.evaluate("window.restored"), true);
      assert.equal(await page.evaluate("document.readyState"), "complete");
      assert.equal(page.frames().length, 7);
      assert.equal(mainNavigations, 1);
      assert.equal(await page.evaluate("document.body._ariaRef.siteOwned"), true);
      const nodes: { name?: string; ref?: string; children?: typeof nodes }[] = JSON.parse(await domSnapshot(page));
      let nestedRef: string | undefined;
      while (nodes.length) {
        const node = nodes.pop()!;
        if (node.name === "Parity cross-nested-cross") nestedRef = node.ref;
        nodes.push(...(node.children || []));
      }
      assert(nestedRef, "restored cross-frame snapshot contains its native ref");
      assert.equal(await page.getByRef(nestedRef).textContent(), "Parity cross-nested-cross");
      assert.equal(
        await page.frameLocator("#cross-frame").frameLocator("#nested-cross-frame").locator("h1").textContent(),
        "Parity cross-nested-cross",
      );
      await page.goForward();
      assert.match(page.url(), /navigation/);
      await page.goBack();
      assert.equal(page.frames().length, 7);
      assert.equal(await page.evaluate("window.restored"), true);
      await context.close();
    } finally {
      await browser?.close();
      await service.close();
      await fixture.close();
    }
  },
);
