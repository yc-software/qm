import { pathToFileURL } from "node:url";
import { ensurePlaywright } from "./playwright-runtime.mjs";
import { installBrowserHistory } from "./browser-history.mjs";
import { startBrowserProxy } from "./browser-proxy.mjs";
import { installBrowserCompatibility } from "./browser-compat.mjs";
import { installBrowserInput } from "./browser-input.mjs";
import { installBrowserFiles } from "./browser-files.mjs";
import { installBrowserUploads } from "./browser-upload.mjs";

export async function startBrowserService(cdpUrl, options = {}) {
  const modulePath = await ensurePlaywright();
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const proxy = await startBrowserProxy(cdpUrl, modulePath);
  const disposers = [];
  let browser;
  let stopping;
  const getError = (error) => proxy.getError?.(error);
  const close = () =>
    (stopping ??= (async () => {
      const errors = [];
      const steps = [() => browser?.unbind(), () => browser?.close(), ...disposers.toReversed(), () => proxy.close()];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Browser service cleanup failed");
    })());
  try {
    browser = await chromium.connectOverCDP(proxy.endpoint, {
      timeout: 30000,
    });
    disposers.push(await installBrowserHistory(browser, modulePath));
    let capabilities = {};
    if (options.provider) {
      const { dispose, ...details } = await installBrowserCompatibility(browser, modulePath);
      disposers.push(dispose);
      capabilities = details;
      disposers.push(await installBrowserInput(browser, modulePath));
      disposers.push(await installBrowserFiles(browser, { browserId: options.browserId, api: options.api }));
      disposers.push(await installBrowserUploads(browser, modulePath));
    }
    const { endpoint } = await browser.bind(options.title || "qm-browse", { host: "127.0.0.1", port: 0 });
    return {
      endpoint,
      browser,
      modulePath,
      capabilities,
      close,
      getError,
      on: (event, listener) => browser.on(event, event === "disconnected" ? () => listener(getError()) : listener),
    };
  } catch (error) {
    const startupError = proxy.getError?.(browser ? undefined : error) || error;
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], "Browser service startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw startupError;
  }
}
