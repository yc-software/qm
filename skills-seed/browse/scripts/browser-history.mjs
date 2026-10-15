import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function restoreBrowserHistory(server, page, current) {
  const { targetInfos } = await server._session.send("Target.getTargets");
  const expected = new Set([page._targetId]);
  let size;
  do {
    size = expected.size;
    for (const target of targetInfos) {
      if (target.type === "iframe" && expected.has(target.parentId)) expected.add(target.targetId);
    }
  } while (size !== expected.size);
  const deadline = Date.now() + 5000;
  while ([...expected].some((id) => !page._sessions.has(id))) {
    if (!current()) return;
    if (Date.now() >= deadline) throw new Error("Restored browser frame targets did not attach");
    await delay(10);
  }
  if (!current()) return;
  const sessions = [...expected].map((id) => page._sessions.get(id));
  const trees = await Promise.all(
    sessions.map(async (session) => ({ session, ...(await session._client.send("Page.getFrameTree")) })),
  );
  if (!current()) return;
  const manager = page._page.frameManager;
  manager.removeChildFramesRecursively(page._page.mainFrame());
  const restore = (session, tree) => {
    const existing = manager.frame(tree.frame.id);
    if (!existing || existing._currentDocument.documentId !== tree.frame.loaderId) {
      if (!existing && tree.frame.id === session._targetId && !session._isMainFrame())
        manager.frameAttached(tree.frame.id, tree.frame.parentId || null);
      session._handleFrameTree(tree, []);
    } else {
      for (const child of tree.childFrames || []) restore(session, child);
    }
  };
  while (trees.length) {
    const index = trees.findIndex(
      ({ frameTree }) => !frameTree.frame.parentId || manager.frame(frameTree.frame.parentId),
    );
    if (index < 0) throw new Error("Restored browser frame tree has no attached parent");
    const { session, frameTree } = trees.splice(index, 1)[0];
    restore(session, frameTree);
  }
  for (const session of sessions) {
    if (!current()) return;
    await session._client.send("Runtime.disable");
    await session._client.send("Runtime.enable");
  }
  for (const session of sessions) {
    for (const context of session._contextIdToContext.values()) {
      if (!current()) return;
      if (context.world !== "utility" || manager.frame(context.frame._id) !== context.frame) continue;
      await context.evaluate(() => {
        const roots = [globalThis.document];
        while (roots.length) {
          for (const element of roots.pop().querySelectorAll("*")) {
            delete element._ariaRef;
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
      });
    }
  }
  for (const session of sessions) {
    if (!current()) return;
    await session._client.send("Page.setLifecycleEventsEnabled", { enabled: false });
    await session._client.send("Page.setLifecycleEventsEnabled", { enabled: true });
  }
}

export async function installBrowserHistory(browser, modulePath) {
  const { version } = JSON.parse(await readFile(join(dirname(modulePath), "package.json"), "utf8"));
  const server = browser._connection?.toImpl?.(browser);
  if (version !== "1.64.0" || !(server?._crPages instanceof Map) || !server.instrumentation?.addListener)
    throw new Error("Browser history compatibility requires pinned Playwright 1.64.0");
  const pages = new Map();
  let disposed = false;
  const release = (page, { state, receive }) => {
    page._mainFrameSession._client.off("Page.frameNavigated", receive);
    for (const [name, original] of state.originals) page._page[name] = original;
    pages.delete(page);
  };
  const prepare = () => {
    for (const [page, entry] of pages) {
      if (!server._crPages.has(page._targetId)) release(page, entry);
    }
    for (const page of server._crPages.values()) {
      if (pages.has(page)) continue;
      const state = { generation: 0, pending: Promise.resolve(), failure: null, originals: new Map() };
      const receive = (event) => {
        if (event.frame.id !== page._targetId) return;
        const generation = ++state.generation;
        state.failure = null;
        if (event.type !== "BackForwardCacheRestore") return;
        const current = () => !disposed && state.generation === generation && server._crPages.has(page._targetId);
        state.pending = restoreBrowserHistory(server, page, current).catch((error) => {
          if (!current()) return;
          state.failure = new Error(`Browser back/forward cache restoration failed: ${error.message}`, {
            cause: error,
          });
          throw state.failure;
        });
        state.pending.catch(() => {});
      };
      for (const name of ["goBack", "goForward"]) {
        const original = page._page[name];
        state.originals.set(name, original);
        page._page[name] = async function (...args) {
          try {
            const result = await original.apply(this, args);
            await state.pending;
            return result;
          } catch (error) {
            if (state.failure) throw new Error(state.failure.message, { cause: error });
            throw error;
          }
        };
      }
      page._mainFrameSession._client.on("Page.frameNavigated", receive);
      pages.set(page, { state, receive });
    }
  };
  const listener = {
    onBeforeCall(_progress, object) {
      if (object.attribution.browser === server) prepare();
    },
    onPageOpen(page) {
      if (page.attribution.browser === server) prepare();
    },
  };
  server.instrumentation.addListener(listener, null);
  prepare();
  const dispose = async () => {
    disposed = true;
    browser.off("disconnected", dispose);
    server.instrumentation.removeListener(listener);
    const pending = [...pages.values()].map(({ state }) => state.pending);
    for (const [page, entry] of pages) release(page, entry);
    await Promise.allSettled(pending);
  };
  browser.once("disconnected", dispose);
  return dispose;
}
