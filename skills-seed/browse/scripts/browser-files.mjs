import { randomUUID } from "node:crypto";
import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { formatBrowserError, withBrowserCleanup } from "./browser-errors.mjs";

export async function copyBrowserArtifact(browser, { path, size, destination, signal, timeoutMs = 120000 }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const partial = `${destination}.part`;
  let context;
  let file;
  let closing;
  const closeContext = () => context && (closing ??= context.close());
  const abort = () => closeContext()?.catch(() => {});
  active.addEventListener("abort", abort, { once: true });
  return withBrowserCleanup(
    async () => {
      try {
        active.throwIfAborted();
        context = await browser.newContext({ acceptDownloads: false });
        active.throwIfAborted();
        const page = await context.newPage();
        await page.goto('data:text/html,<input type="file">', { waitUntil: "commit", timeout: timeoutMs });
        const session = await context.newCDPSession(page);
        const input = await session.send("Runtime.evaluate", { expression: 'document.querySelector("input")' });
        if (!input.result?.objectId) throw new Error("Browser artifact reader could not initialize");
        await session.send("DOM.setFileInputFiles", { objectId: input.result.objectId, files: [path] });
        const remote = await session.send("Runtime.evaluate", {
          expression: 'document.querySelector("input").files[0]',
        });
        if (!remote.result?.objectId) throw new Error("Browser artifact file is missing");
        const metadata = await session.send("Runtime.callFunctionOn", {
          objectId: remote.result.objectId,
          functionDeclaration: "function() { return { size: this.size }; }",
          returnByValue: true,
        });
        if (metadata.result?.value?.size !== size)
          throw new Error("Browser artifact size differs from completed download");
        file = await open(partial, "wx", 0o600);
        for (let offset = 0; offset < size; offset += 1024 * 1024) {
          active.throwIfAborted();
          const length = Math.min(1024 * 1024, size - offset);
          const chunk = await session.send("Runtime.callFunctionOn", {
            objectId: remote.result.objectId,
            functionDeclaration: `async function(offset, length) {
          const bytes = new Uint8Array(await this.slice(offset, offset + length).arrayBuffer());
          let text = "";
          for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
          return btoa(text);
        }`,
            arguments: [{ value: offset }, { value: length }],
            awaitPromise: true,
            returnByValue: true,
          });
          if (chunk.exceptionDetails || typeof chunk.result?.value !== "string")
            throw new Error("Browser artifact changed or became unreadable during transfer", {
              cause: chunk.exceptionDetails,
            });
          const bytes = Buffer.from(chunk.result.value, "base64");
          if (bytes.length !== length) throw new Error("Browser artifact was truncated during transfer");
          await file.writeFile(bytes);
        }
        active.throwIfAborted();
        await file.close();
        file = undefined;
        await rename(partial, destination);
      } catch (error) {
        if (deadline.aborted) throw new Error("Browser artifact transfer exceeded its deadline", { cause: error });
        if (signal?.aborted) throw new Error("Browser artifact transfer stopped", { cause: error });
        if (error?.message?.startsWith("Browser artifact")) throw error;
        throw new Error("Browser artifact transfer failed", { cause: error });
      }
    },
    () => active.removeEventListener("abort", abort),
    () => file?.close(),
    closeContext,
    () => rm(partial, { force: true }),
  );
}

export async function installBrowserFiles(browser, { timeoutMs = 120000, privateValues = [] } = {}) {
  const impl = browser._connection?.toImpl?.(browser);
  if (
    !impl?._session?.prependListener ||
    typeof impl.downloadFinished !== "function" ||
    !(impl._downloads instanceof Map)
  )
    throw new Error("Pinned Playwright browser file integration is incompatible");
  const directory = await mkdtemp(join(tmpdir(), "qm-browser-files-"));
  const stop = new AbortController();
  const completed = new Map();
  const paths = new Map();
  const pending = new Map();
  const transfers = new Set();
  const names = new Map();
  const downloadNames = new Map();
  const ambiguous = new Set();
  const finish = impl.downloadFinished;
  const create = impl.downloadCreated;
  const send = impl._session.send;
  const settle = (guid, error) => {
    const name = downloadNames.get(guid);
    if (names.get(name) === guid) names.delete(name);
    downloadNames.delete(guid);
    ambiguous.delete(guid);
    completed.delete(guid);
    for (const [path, owner] of paths) if (owner === guid) paths.delete(path);
    return finish.call(impl, guid, error);
  };
  const progress = (event) => {
    if (event.state === "completed" && impl._downloads.has(event.guid)) completed.set(event.guid, event);
  };
  impl._session.prependListener("Browser.downloadProgress", progress);
  impl._session.send = function (method, params, ...rest) {
    if (
      method === "Browser.setDownloadBehavior" &&
      params?.downloadPath &&
      !(
        posix.normalize(params.downloadPath) === params.downloadPath &&
        (params.downloadPath === "/downloads" || params.downloadPath.startsWith("/downloads/"))
      )
    )
      params = { ...params, downloadPath: "/downloads" };
    return send.call(this, method, params, ...rest);
  };
  impl.downloadCreated = function (page, guid, url, name, ...rest) {
    create.call(this, page, guid, url, name, ...rest);
    if (name && names.has(name)) {
      const previous = names.get(name);
      ambiguous.add(previous);
      ambiguous.add(guid);
      pending.get(previous)?.abort();
      settle(previous, "Browser overwrote a concurrent download filename; artifact bytes are ambiguous");
    }
    if (name) names.set(name, guid);
    downloadNames.set(guid, name);
  };
  impl.downloadFinished = function (guid, error) {
    if (error) {
      pending.get(guid)?.abort();
      return settle(guid, error);
    }
    if (pending.has(guid)) return;
    if (ambiguous.has(guid))
      return settle(guid, "Browser overwrote a concurrent download filename; artifact bytes are ambiguous");
    const download = this._downloads.get(guid);
    if (!download) return;
    const event = completed.get(guid);
    completed.delete(guid);
    const path = event?.filePath;
    if (
      !path?.startsWith("/downloads/") ||
      posix.normalize(path) !== path ||
      path.includes("\0") ||
      !Number.isSafeInteger(event.totalBytes) ||
      event.totalBytes < 0
    )
      return settle(guid, "Browser did not identify the completed download artifact");
    if (paths.has(path) && paths.get(path) !== guid) {
      const previous = paths.get(path);
      pending.get(previous)?.abort();
      settle(previous, "Browser overwrote a concurrent download path; artifact bytes are ambiguous");
      return settle(guid, "Browser overwrote a concurrent download path; artifact bytes are ambiguous");
    }
    paths.set(path, guid);
    const controller = new AbortController();
    pending.set(guid, controller);
    const destination = join(directory, randomUUID());
    download.artifact._localPath = destination;
    const signal = AbortSignal.any([stop.signal, controller.signal]);
    const transfer = copyBrowserArtifact(browser, { path, size: event.totalBytes, destination, signal, timeoutMs })
      .then(
        () => settle(guid, ""),
        (failure) => settle(guid, formatBrowserError(failure, privateValues)),
      )
      .finally(() => {
        pending.delete(guid);
        transfers.delete(transfer);
      });
    transfers.add(transfer);
  };
  return async () => {
    stop.abort();
    for (const guid of pending.keys()) settle(guid, "Browser artifact transfer stopped");
    await Promise.allSettled(transfers);
    impl.downloadFinished = finish;
    impl.downloadCreated = create;
    impl._session.send = send;
    impl._session.removeListener("Browser.downloadProgress", progress);
    await rm(directory, { recursive: true, force: true });
  };
}
