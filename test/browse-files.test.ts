import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { copyBrowserArtifact, installBrowserFiles } = await import(
  new URL("../skills-seed/browse/scripts/browser-files.mjs", import.meta.url).href
);
async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "browse-file-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function remoteReader(bytes: Buffer, broken = false) {
  const calls: Array<{ method: string; params: any }> = [];
  let closed = 0;
  return {
    calls,
    closed: () => closed,
    newContext: async () => ({
      newPage: async () => ({ goto: async () => {} }),
      close: async () => {
        closed++;
      },
      newCDPSession: async () => ({
        send: async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === "DOM.setFileInputFiles") return {};
          if (method === "Runtime.evaluate") return { result: { objectId: "file" } };
          if (!params.arguments) return { result: { value: { size: bytes.length } } };
          if (broken) return { exceptionDetails: { text: "NotReadableError" } };
          const [offset, length] = params.arguments.map((arg: any) => arg.value);
          return { result: { value: bytes.subarray(offset, offset + length).toString("base64") } };
        },
      }),
    }),
  };
}
test("actual remote artifact paths stream binary chunks to a private local file", async () => {
  await temporary(async (dir) => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 0xff);
    bytes[0] = 0;
    const browser = remoteReader(bytes);
    const destination = join(dir, "saved");
    await copyBrowserArtifact(browser, { path: "/downloads/exact.bin", size: bytes.length, destination });
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(browser.calls.find((call) => call.method === "DOM.setFileInputFiles")?.params.files, [
      "/downloads/exact.bin",
    ]);
    assert.equal(browser.calls.filter((call) => call.params.arguments).length, 3);
    assert.equal(browser.closed(), 1);
  });
});
test("missing, changed, and truncated remote artifacts cannot publish a local path", async () => {
  await temporary(async (dir) => {
    for (const broken of [false, true]) {
      const browser = remoteReader(Buffer.from([1, 2, 3]), broken);
      const destination = join(dir, String(broken));
      await assert.rejects(
        copyBrowserArtifact(browser, { path: "/downloads/a", size: broken ? 3 : 4, destination }),
        broken ? /unreadable/ : /size differs/,
      );
      await assert.rejects(stat(destination), { code: "ENOENT" });
      await assert.rejects(stat(destination + ".part"), { code: "ENOENT" });
      assert.equal(browser.closed(), 1);
    }
  });
});
test("aborted transfer does not touch the browser or publish bytes", async () => {
  await temporary(async (dir) => {
    const browser = remoteReader(Buffer.from([1]));
    await assert.rejects(
      copyBrowserArtifact(browser, {
        path: "/downloads/a",
        size: 1,
        destination: join(dir, "saved"),
        signal: AbortSignal.abort(),
      }),
      /stopped/,
    );
    assert.equal(browser.calls.length, 0);
  });
});
function nativeFixture(bytes = Buffer.from([0, 255, 42])) {
  const session = Object.assign(new EventEmitter(), { send: async (_method: string, params: any) => params });
  const completed: Array<{ guid: string; error: string; path?: string }> = [];
  const impl = {
    _session: session,
    _downloads: new Map<string, any>(),
    downloadCreated(_page: any, guid: string, _url: string, _name: string) {
      this._downloads.set(guid, { artifact: {} });
    },
    downloadFinished(guid: string, error: string) {
      if (!this._downloads.has(guid)) return;
      completed.push({ guid, error, path: this._downloads.get(guid).artifact._localPath });
      this._downloads.delete(guid);
    },
  };
  session.on("Browser.downloadProgress", (event) => {
    if (event.state === "completed") impl.downloadFinished(event.guid, "");
  });
  const browser = Object.assign(remoteReader(bytes), { _connection: { toImpl: () => impl } });
  const complete = (guid: string, path = "/downloads/a") =>
    session.emit("Browser.downloadProgress", { state: "completed", guid, filePath: path, totalBytes: bytes.length });
  return { browser, impl, completed, complete };
}
async function waitUntil(check: () => boolean) {
  const until = Date.now() + 2000;
  while (!check()) {
    assert(Date.now() < until, "completion timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test("native completion waits for bytes, preserves provider directory, and permits sequential same names", async () => {
  const { browser, impl, completed, complete } = nativeFixture();
  const dispose = await installBrowserFiles(browser);
  try {
    assert.equal(
      (
        await impl._session.send("Browser.setDownloadBehavior", {
          downloadPath: "/tmp/local",
          behavior: "allowAndName",
        })
      ).downloadPath,
      "/downloads",
    );
    for (const guid of ["one", "two"]) {
      impl.downloadCreated(null, guid, "blob:original", "a");
      complete(guid);
      await waitUntil(() => completed.some((entry) => entry.guid === guid));
      const result = completed.find((entry) => entry.guid === guid)!;
      assert.equal(result.error, "");
      assert.deepEqual([...(await readFile(result.path!))], [0, 255, 42]);
    }
  } finally {
    await dispose();
  }
});
test("same-name concurrent downloads fail safely without reading either artifact", async () => {
  const { browser, impl, completed } = nativeFixture();
  const dispose = await installBrowserFiles(browser);
  try {
    impl.downloadCreated(null, "one", "blob:one", "same");
    impl.downloadCreated(null, "two", "blob:two", "same");
    impl.downloadFinished("two", "");
    assert.equal(completed.length, 2);
    assert(completed.every((entry) => entry.error.includes("ambiguous")));
    assert.equal(browser.calls.length, 0);
  } finally {
    await dispose();
  }
});
test("unidentified and traversing completed paths fail without filesystem access", async () => {
  for (const path of [undefined, "/downloads/../secret", "/etc/passwd"]) {
    const { browser, impl, completed } = nativeFixture();
    const dispose = await installBrowserFiles(browser);
    try {
      impl.downloadCreated(null, "one", "blob:one", "a");
      impl._session.emit("Browser.downloadProgress", {
        state: "completed",
        guid: "one",
        filePath: path,
        totalBytes: 3,
      });
      assert(completed[0]);
      assert.match(completed[0].error, /did not identify/);
      assert.equal(browser.calls.length, 0);
    } finally {
      await dispose();
    }
  }
});
test("native cancellation bypasses transfer and cleanup restores hooks", async () => {
  const { browser, impl, completed } = nativeFixture();
  const original = impl.downloadFinished;
  const dispose = await installBrowserFiles(browser);
  impl.downloadCreated(null, "one", "blob:one", "a");
  impl.downloadFinished("one", "canceled");
  assert(completed[0]);
  assert.equal(completed[0].error, "canceled");
  await dispose();
  assert.equal(impl.downloadFinished, original);
  assert.equal(impl._session.listenerCount("Browser.downloadProgress"), 1);
});

test(
  "hosted Chromium full-protocol files retain real GET, POST, blob, chooser and upload bytes",
  { skip: process.env.BROWSE_TEST_PROVIDER_FILES !== "1", timeout: 240000 },
  async () => {
    const { ensurePlaywright } = await import(
      new URL("../skills-seed/browse/scripts/playwright-runtime.mjs", import.meta.url).href
    );
    const { chromium } = await import(pathToFileURL(await ensurePlaywright()).href);
    const api = async (method: string, path: string, body?: any) => {
      const response = await fetch(`https://api.browser-use.com/api/v4${path}`, {
        method,
        headers: { "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY!, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert(response.ok, `Browser Use ${method}: HTTP ${response.status}`);
      return response.json();
    };
    let id: string | undefined;
    let service: any;
    let client: any;
    try {
      const created = await api("POST", "/browsers", { proxyCountryCode: null, timeout: 5, allowResizing: true });
      assert(created && typeof created === "object" && "id" in created && typeof created.id === "string");
      id = created.id;
      assert("cdpUrl" in created && typeof created.cdpUrl === "string");
      const { startBrowserService } = await import(
        new URL("../skills-seed/browse/scripts/browser-service.mjs", import.meta.url).href
      );
      service = await startBrowserService(created.cdpUrl, { provider: true, browserId: id });
      client = await chromium.connect(service.endpoint);
      await temporary(async (dir) => {
        const context = client.contexts()[0];
        const page = context.pages()[0];
        assert(page, "Fresh Browser Use session must have an initial default-context page");
        await page.goto('data:text/html,<input type=file multiple><a download="same.bin">Download</a>', {
          waitUntil: "commit",
        });
        const input = page.locator("input");
        const bytes = Buffer.from([0, 255, 11, 22]);
        await input.setInputFiles([{ name: "binary.bin", mimeType: "application/octet-stream", buffer: bytes }]);
        assert.deepEqual(await input.evaluate(async (e: any) => [...new Uint8Array(await e.files[0].arrayBuffer())]), [
          ...bytes,
        ]);
        const local = join(dir, "local.txt");
        await writeFile(local, "local-path");
        const choosing = page.waitForEvent("filechooser");
        await input.click();
        await (await choosing).setFiles(local);
        assert.equal(await input.evaluate((e: any) => e.files[0].text()), "local-path");
        await input.setInputFiles([]);
        assert.equal(await input.evaluate((e: any) => e.files.length), 0);
        for (const index of [0, 1]) {
          const contents = Buffer.alloc(1024 * 1024 + 3, index + 7);
          await page.evaluate(
            `document.querySelector("a").href = URL.createObjectURL(new Blob([new Uint8Array(${contents.length}).fill(${index + 7})]));`,
          );
          const downloading = page.waitForEvent("download");
          await page.locator("a").click();
          const download = await downloading;
          const saved = join(dir, `blob-${index}`);
          await download.saveAs(saved);
          assert.deepEqual(await readFile(saved), contents);
          const chunks = [];
          for await (const chunk of await download.createReadStream()) chunks.push(chunk);
          assert.deepEqual(Buffer.concat(chunks), contents);
          assert.equal(await download.failure(), null);
          await download.delete();
          await assert.rejects(download.saveAs(join(dir, `deleted-${index}`)), /deleted|closed/);
        }
        const requests: string[] = [];
        await context.route("https://files.test/**", async (route: any) => {
          const method = route.request().method();
          requests.push(method);
          if (route.request().url().endsWith("/form"))
            return route.fulfill({
              contentType: "text/html",
              body: '<form method="post" action="https://files.test/post"><button>Post</button></form>',
            });
          await route.fulfill({
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${method}.bin"`,
            },
            body: Buffer.from(`actual-${method}-response`),
          });
        });
        for (const method of ["GET", "POST"]) {
          if (method === "GET") {
            await page.goto('data:text/html,<a href="https://files.test/get">Get</a>');
          } else await page.goto("https://files.test/form");
          const downloading = page.waitForEvent("download");
          await page.locator(method === "GET" ? "a" : "button").click();
          const download = await downloading;
          const saved = join(dir, method);
          await download.saveAs(saved);
          assert.equal(await readFile(saved, "utf8"), `actual-${method}-response`);
        }
        assert.deepEqual(requests, ["GET", "GET", "POST"]);
        await page.goto('data:text/html,<a download="cancel.bin">Cancel</a>');
        await page.evaluate(
          'document.querySelector("a").href = URL.createObjectURL(new Blob([new Uint8Array(64 * 1024 * 1024)]));',
        );
        const cancelling = page.waitForEvent("download");
        const clicking = page.locator("a").click();
        const cancelled = await cancelling;
        await cancelled.cancel();
        await clicking;
        assert.match(await cancelled.failure(), /canceled/);
        await page.close();
      });
    } finally {
      try {
        await client?.close();
        await service?.close();
      } finally {
        if (id) await api("PATCH", `/browsers/${id}`, { action: "stop" });
      }
    }
  },
);

test("artifact failures retain diagnostic causes while redacting private values", async () => {
  const { browser, completed, impl, complete } = nativeFixture();
  browser.newContext = async () => {
    throw new Error("read secret-endpoint failed", {
      cause: Object.assign(new Error("not accessible"), { code: "EACCES" }),
    });
  };
  const dispose = await installBrowserFiles(browser, { privateValues: ["secret-endpoint"] });
  try {
    impl.downloadCreated(null, "one", "blob:one", "a");
    complete("one");
    await waitUntil(() => completed.length === 1);
    assert(completed[0]);
    assert.match(completed[0].error, /EACCES/);
    assert.match(completed[0].error, /not accessible/);
    assert.match(completed[0].error, /private browser value/);
    assert(!completed[0].error.includes("secret-endpoint"));
  } finally {
    await dispose();
  }
});

test("artifact read and context cleanup failures survive while partial bytes are removed", async () => {
  await temporary(async (dir) => {
    const browser = remoteReader(Buffer.from([1, 2, 3]), true);
    const createContext = browser.newContext;
    let closed = 0;
    browser.newContext = async () => ({
      ...(await createContext()),
      close: async () => {
        closed++;
        throw new Error("context cleanup failed");
      },
    });
    const destination = join(dir, "saved");
    await assert.rejects(
      copyBrowserArtifact(browser, { path: "/downloads/a", size: 3, destination }),
      (error: unknown) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /unreadable/);
        assert.match(error.errors[1].message, /context cleanup failed/);
        return true;
      },
    );
    assert.equal(closed, 1);
    await assert.rejects(stat(destination), { code: "ENOENT" });
    await assert.rejects(stat(destination + ".part"), { code: "ENOENT" });
  });
});
