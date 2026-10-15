import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withBrowserCleanup } from "./browser-errors.mjs";

export async function installBrowserCompatibility(browser, modulePath) {
  const { version } = JSON.parse(await readFile(join(dirname(modulePath), "package.json"), "utf8"));
  if (version !== "1.64.0") throw new Error("Browser compatibility requires Playwright 1.64.0");
  const server = browser._connection?.toImpl?.(browser);
  if (!(server?._crPages instanceof Map) || !server.instrumentation?.addListener)
    throw new Error("Browser compatibility requires the pinned in-process Chromium server");
  const probe = await browser.contexts()[0].newPage();
  let hasRuntimeConsole = false;
  let session;
  await withBrowserCleanup(
    async () => {
      session = await probe.context().newCDPSession(probe);
      session.on("Runtime.consoleAPICalled", () => {
        hasRuntimeConsole = true;
      });
      await session.send("Runtime.enable");
      await session.send("Runtime.evaluate", { expression: "console.debug('qm console capability probe')" });
    },
    () => session?.detach(),
    () => probe.close(),
  );
  if (hasRuntimeConsole) return { consoleSource: "Runtime.consoleAPICalled", consoleArguments: true, dispose() {} };
  const sessions = new Map();
  const prepare = () => {
    const pending = [];
    for (const [session, { receive }] of sessions) {
      if (!session._closed) continue;
      session.off("Console.messageAdded", receive);
      session.off("Target.attachedToTarget", onAttached);
      session.off("Target.detachedFromTarget", onAttached);
      sessions.delete(session);
    }
    for (const page of server._crPages.values()) {
      for (const frame of page._sessions.values()) {
        const session = frame._client;
        if (!sessions.has(session)) {
          const receive = ({ message }) => {
            if (message.source !== "console-api") return;
            page._page.addConsoleMessage(
              null,
              message.level,
              [],
              {
                url: message.url || "",
                lineNumber: Math.max(0, (message.line || 1) - 1),
                columnNumber: Math.max(0, (message.column || 1) - 1),
              },
              message.text,
              Date.now(),
            );
          };
          session.on("Console.messageAdded", receive);
          session.on("Target.attachedToTarget", onAttached);
          session.on("Target.detachedFromTarget", onAttached);
          const ready = session.send("Console.enable");
          ready.catch(() => {});
          sessions.set(session, { receive, ready });
        }
        pending.push(sessions.get(session).ready);
      }
    }
    return Promise.all(pending);
  };
  const onAttached = () => {
    prepare().catch(() => {});
  };
  const listener = {
    async onBeforeCall(_progress, object) {
      if (object.attribution.browser === server) await prepare();
    },
    onPageOpen(page) {
      if (page.attribution.browser === server) onAttached();
    },
  };
  server._session.on("Target.attachedToTarget", onAttached);
  server._session.on("Target.detachedFromTarget", onAttached);
  server.instrumentation.addListener(listener, null);
  const dispose = () => {
    browser.off("disconnected", dispose);
    server._session.off("Target.attachedToTarget", onAttached);
    server._session.off("Target.detachedFromTarget", onAttached);
    server.instrumentation.removeListener(listener);
    for (const [session, { receive }] of sessions) {
      session.off("Console.messageAdded", receive);
      session.off("Target.attachedToTarget", onAttached);
      session.off("Target.detachedFromTarget", onAttached);
    }
    sessions.clear();
  };
  browser.once("disconnected", dispose);
  try {
    await prepare();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    consoleSource: "Console.messageAdded",
    consoleArguments: false,
    consoleType: "severity",
    consoleTimestamp: "received",
    dispose,
  };
}
