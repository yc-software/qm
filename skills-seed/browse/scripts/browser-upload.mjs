import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { withBrowserCleanup } from "./browser-errors.mjs";

const CHUNK_BYTES = 256 * 1024;
const NATIVE_INLINE_LIMIT = 50 * 1024 * 1024;

async function largeUploadSources(params, frame) {
  if (params.localPaths && !frame.attribution.playwright.options.isClientCollocatedWithServer)
    throw new Error("localPaths are not allowed when the client is not local");
  if (
    [params.payloads, params.localPaths, params.localDirectory, params.streams, params.directoryStream].filter(Boolean)
      .length !== 1
  )
    throw new Error("Exactly one of payloads, localPaths and streams must be provided");
  if (params.payloads || params.localDirectory || params.directoryStream) return null;
  const paths = params.localPaths || params.streams?.map((stream) => stream.path());
  if (!paths) return null;
  const files = await Promise.all(
    paths.map(async (path) => {
      if (!isAbsolute(path) || resolve(path) !== path)
        throw new Error("Upload paths must be absolute and fully resolved");
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`Upload source is not a regular file: ${path}`);
      return { path, name: basename(path), size: info.size, lastModified: Math.floor(info.mtimeMs) };
    }),
  );
  return files.reduce((sum, file) => sum + file.size, 0) >= NATIVE_INLINE_LIMIT ? files : null;
}

async function assignFiles(progress, input, files, mime) {
  const state = await progress.race(
    input.evaluateHandle((node) => ({ node, parts: [], transfer: new globalThis.DataTransfer() })),
  );
  return withBrowserCleanup(
    async () => {
      for (const file of files) {
        const stream = createReadStream(file.path, { highWaterMark: CHUNK_BYTES, signal: progress.signal });
        let total = 0;
        await withBrowserCleanup(
          async () => {
            for await (const bytes of stream) {
              progress.signal.throwIfAborted();
              total += bytes.length;
              await progress.race(
                state.evaluate((value, base64) => {
                  const binary = atob(base64);
                  const bytes = new Uint8Array(binary.length);
                  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
                  value.parts.push(new Blob([bytes]));
                }, bytes.toString("base64")),
              );
            }
          },
          () => stream.destroy(),
        );
        if (total !== file.size) throw new Error(`Upload source changed size during transfer: ${file.name}`);
        await progress.race(
          state.evaluate(
            (value, metadata) => {
              value.transfer.items.add(
                new File(value.parts, metadata.name, { type: metadata.type, lastModified: metadata.lastModified }),
              );
              value.parts = [];
            },
            {
              name: file.name,
              type: mime.getType(file.name) || "application/octet-stream",
              lastModified: file.lastModified,
            },
          ),
        );
      }
      return await progress.race(
        state.evaluate(({ node, transfer }) => {
          if (!node.isConnected) return "error:notconnected";
          node.files = transfer.files;
          node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
          return "done";
        }),
      );
    },
    () => state.dispose(),
  );
}

export async function installBrowserUploads(browser, modulePath) {
  const { version } = JSON.parse(await readFile(join(dirname(modulePath), "package.json"), "utf8"));
  if (version !== "1.64.0") throw new Error("Browser uploads require Playwright 1.64.0");
  const server = browser._connection?.toImpl?.(browser);
  if (!(server?._crPages instanceof Map) || !server.instrumentation?.addListener)
    throw new Error("Browser uploads require the pinned in-process Chromium server");
  const { mime } = createRequire(modulePath)(join(dirname(modulePath), "lib/utilsBundle.js"));
  const patched = new Map();
  const setFiles = async (progress, handle, files, box) => {
    const input = await progress.race(
      handle._evaluateHandleInUtility(([injected, node, multiple]) => {
        const element = injected.retarget(node, "follow-label");
        if (!element) return;
        if (element.tagName !== "INPUT") throw injected.createStacklessError("Node is not an HTMLInputElement");
        if (element.type !== "file") throw injected.createStacklessError("Not an input[type=file] element");
        if (multiple && !element.multiple && !element.webkitdirectory)
          throw injected.createStacklessError("Non-multiple file input can only accept single file");
        if (element.webkitdirectory)
          throw injected.createStacklessError("[webkitdirectory] input requires passing a path to a directory");
        return element;
      }, files.length > 1),
    );
    if (input === "error:notconnected") return input;
    return withBrowserCleanup(
      async () => {
        if (!input.asElement()) return "error:notconnected";
        await handle.instrumentation.onBeforeInputAction(progress, handle, undefined, box);
        return await assignFiles(progress, input.asElement(), files, mime);
      },
      () => input.dispose(),
    );
  };
  const listener = {
    onBeforeCall(progress, object) {
      if (object.attribution.browser !== server || progress.metadata.method !== "setInputFiles") return;
      if (patched.has(object)) {
        patched.get(object).calls++;
        return;
      }
      const original = object.setInputFiles;
      if (typeof original !== "function") throw new Error("Pinned Playwright upload method is missing");
      patched.set(object, { original, calls: 1 });
      object.setInputFiles = async function (progress, ...args) {
        const files = await progress.race(largeUploadSources(args.at(-1), this._frame || this));
        if (!files) return original.call(this, progress, ...args);
        if (!this._frame) {
          await this._retryWithProgressIfNotConnected(
            progress,
            args[0],
            { waitForFrameVisible: false },
            (next, handle, box) => setFiles(next, handle, files, box),
          );
          return;
        }
        await this._markAsTargetElement(progress);
        if ((await setFiles(progress, this, files)) === "error:notconnected")
          throw new Error("Element is not attached to the DOM");
      };
    },
    onAfterCall(progress, object) {
      if (progress.metadata.method !== "setInputFiles") return;
      const entry = patched.get(object);
      if (entry && --entry.calls === 0) {
        object.setInputFiles = entry.original;
        patched.delete(object);
      }
    },
  };
  server.instrumentation.addListener(listener, null);
  const dispose = () => {
    server.instrumentation.removeListener(listener);
    for (const [object, { original }] of patched) object.setInputFiles = original;
    patched.clear();
    browser.off("disconnected", dispose);
  };
  browser.once("disconnected", dispose);
  return dispose;
}
