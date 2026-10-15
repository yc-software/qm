import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { createBrowserClient } = await import(
  new URL("../skills-seed/browse/scripts/browser-client.mjs", import.meta.url).href
);

const { domSnapshot } = await import(
  new URL("../skills-seed/browse/scripts/browser-snapshot.mjs", import.meta.url).href
);

function mockBrowser() {
  const calls: unknown[][] = [];
  const pages: any[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const context = {
    pages: () => pages,
    newCDPSession: async () => ({ send: record("cdp"), detach: record("detach") }),
    newPage: async () => {
      const page = Object.assign(new EventEmitter(), {
        _guid: `page-${pages.length}`,
        context: () => context,
        url: () => "https://example.test",
        title: async () => "Example",
        goto: record("goto"),
        goBack: record("back"),
        goForward: record("forward"),
        reload: record("reload"),
        close: async () => {
          pages.splice(pages.indexOf(page), 1);
        },
        keyboard: { down: record("down"), up: record("up"), insertText: record("text") },
        mouse: {
          click: record("click"),
          dblclick: record("double"),
          move: record("move"),
          down: record("mouseDown"),
          up: record("mouseUp"),
          wheel: record("wheel"),
        },
        getByRef: (id: string) => ({
          click: record(id),
          dblclick: record(`${id}:double`),
          hover: record(`${id}:hover`),
        }),
        consoleMessages: async () =>
          ["warning", "error", "log"].map((type) => ({
            type: () => type,
            text: () => `${type} message`,
            location: () => ({ url: "https://example.test" }),
          })),
        evaluate: async (fn: (...args: any[]) => unknown, arg: unknown) => fn(arg),
        waitForNavigation: async (...args: unknown[]) => {
          calls.push(["navigation", ...args]);
          return "response";
        },
      });
      pages.push(page);
      return page;
    },
  };
  const native = { contexts: () => [context], newContext: async () => context };
  return { native, context, calls };
}

test("client retains native Browser and Page identity, events, functions and stable IDs", async () => {
  const { native, context, calls } = mockBrowser();
  const page = await context.newPage();
  const extensions: unknown[] = [];
  const browser = createBrowserClient(native, {
    extendTab: (tab: unknown, value: unknown) => extensions.push([tab, value]),
  });
  const tab = browser.tabs.get(page._guid);
  assert.equal(browser.playwright, native);
  assert.equal(tab.playwright, page);
  assert.equal(browser.tabs.get(page._guid), tab);
  assert.equal(extensions.length, 1);
  assert.deepEqual(await browser.tabs.list(), [{ id: page._guid, title: "Example", url: "https://example.test" }]);
  assert.equal(await tab.evaluate((value: { a: number }) => value.a + 1, { a: 2 }), 3);
  let observed;
  tab.playwright.on("request", (request: unknown) => {
    observed = request;
  });
  page.emit("request", "native-request");
  assert.equal(observed, "native-request");
  await tab.goto("https://next.test", { waitUntil: "commit", timeout: 700 });
  await tab.back({ timeout: 50 });
  await tab.forward();
  await tab.reload();
  assert.deepEqual(calls, [
    ["goto", "https://next.test", { waitUntil: "commit", timeout: 700 }],
    ["back", { timeout: 50 }],
    ["forward"],
    ["reload"],
  ]);
  assert.equal(await tab.playwright.expectNavigation(() => calls.push(["action"]), { timeoutMs: 250 }), "response");
  assert.deepEqual(calls.slice(-2), [["navigation", { timeout: 250 }], ["action"]]);
  const added = await browser.tabs.new("https://new.test");
  added.playwright.evaluate = async () => true;
  assert.equal(await browser.tabs.selected(), added);
  added.playwright.evaluate = async () => false;
  page.evaluate = async () => true;
  assert.equal(await browser.tabs.selected(), tab);
  await added.close();
  assert.throws(() => browser.tabs.get(added.id), /No open tab/);
});

test("CUA maps native coordinates, chords, text, wheel and back/forward buttons", async () => {
  const { native, context, calls } = mockBrowser();
  const page = await context.newPage();
  const { cua, dom_cua } = createBrowserClient(native).tabs.get(page._guid);
  await cua.click({ x: 4, y: 5, button: 3, keypress: ["SHIFT"] });
  await cua.double_click({ x: 8, y: 9 });
  await cua.keypress({ keys: ["CTRL", "a"] });
  await cua.type({ text: "日本語" });
  await cua.scroll({ x: 4, y: 5, scrollX: 6, scrollY: 7 });
  await cua.drag({
    path: [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
  });
  assert.deepEqual(calls, [
    ["down", "Shift"],
    ["click", 4, 5, { button: "right" }],
    ["up", "Shift"],
    ["double", 8, 9],
    ["down", "Control"],
    ["down", "a"],
    ["up", "a"],
    ["up", "Control"],
    ["text", "日本語"],
    ["move", 4, 5],
    ["wheel", 6, 7],
    ["move", 1, 2],
    ["mouseDown"],
    ["move", 3, 4],
    ["mouseUp"],
  ]);
  await dom_cua.click({ node_id: "f1e2", button: "middle", modifiers: ["Alt"] });
  assert.deepEqual(calls.at(-1), ["f1e2", { button: "middle", modifiers: ["Alt"] }]);
  for (const button of [4, 5]) {
    await cua.click({ x: 1, y: 2, button, keypress: ["CTRL"] });
    assert.deepEqual(
      calls.slice(-5).map((call) => call[0]),
      ["down", "cdp", "cdp", "detach", "up"],
    );
    assert.equal((calls.at(-4)?.[2] as any).button, button === 4 ? "back" : "forward");
    assert.equal((calls.at(-4)?.[2] as any).modifiers, 2);
  }
});

test("CUA releases held keys and mouse after failures, preserving cleanup failures", async () => {
  const { native, context, calls } = mockBrowser();
  const page = await context.newPage();
  const { cua } = createBrowserClient(native).tabs.get(page._guid);
  page.mouse.click = async () => {
    throw new Error("target closed");
  };
  await assert.rejects(cua.click({ x: 1, y: 2, keypress: ["SHIFT", "ALT"] }), /target closed/);
  assert.deepEqual(calls, [
    ["down", "Shift"],
    ["down", "Alt"],
    ["up", "Alt"],
    ["up", "Shift"],
  ]);
  page.keyboard.up = async () => {
    throw new Error("cleanup failed");
  };
  await assert.rejects(
    cua.click({ x: 1, y: 2, keypress: ["SHIFT"] }),
    (error: any) =>
      error instanceof AggregateError &&
      error.errors.map((entry) => entry.message).join(",") === "target closed,cleanup failed",
  );
  let moves = 0;
  page.mouse.move = async () => {
    if (++moves === 2) throw new Error("drag interrupted");
  };
  await assert.rejects(
    cua.drag({
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    }),
    /drag interrupted/,
  );
  assert.deepEqual(calls.at(-1), ["mouseUp"]);
});

test("CUA retains primary and cleanup errors while attempting every release", async () => {
  const { native, context } = mockBrowser();
  const page = await context.newPage();
  const cua = createBrowserClient(native).tabs.get(page._guid).cua;
  const failures = [new Error("press failed"), new Error("release failed"), new Error("detach failed")];
  for (const failAt of [[0, 1, 2], [0], [1, 2]]) {
    const calls: number[] = [];
    const step = async (index: number) => {
      calls.push(index);
      if (failAt.includes(index)) throw failures[index];
    };
    Object.assign(context, {
      newCDPSession: async () => ({
        send: async (_method: string, params: { type: string }) => step(params.type === "mousePressed" ? 0 : 1),
        detach: async () => step(2),
      }),
    });
    await assert.rejects(cua.click({ x: 1, y: 2, button: 4 }), (error: unknown) => {
      if (failAt.length === 1) assert.equal(error, failures[failAt[0]!]);
      else {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors,
          failAt.map((index) => failures[index]),
        );
      }
      return true;
    });
    assert.deepEqual(calls, [0, 1, 2]);
  }
  let moves = 0;
  page.mouse.move = async () => {
    if (++moves === 2) throw failures[0];
  };
  page.mouse.up = async () => {
    throw failures[1];
  };
  await assert.rejects(
    cua.drag({
      path: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures.slice(0, 2));
      return true;
    },
  );
});

function snapshotSession(read: () => unknown) {
  return {
    send: async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") return { result: { value: await read() } };
      throw new Error(`Unexpected command ${method}`);
    },
    detach: async () => {},
  };
}

test("snapshots mask editable values structurally without changing labels, references or native data", async () => {
  const { native, context } = mockBrowser();
  const page = await context.newPage();
  const original = [
    { role: "textbox", name: "A label", ref: "e1", text: "a" },
    { role: "spinbutton", ref: "e2", children: ["123", { role: "text", text: "456" }] },
    { role: "combobox", ref: "e3", children: [{ role: "option", name: "Option a", selected: true }] },
    { role: "paragraph", text: "Normal a label" },
    { role: "iframe", children: [{ role: "textbox", ref: "f1e1", text: "frame value" }] },
  ];
  Object.assign(page, {
    ariaSnapshotJSON: async () => original,
    frames: () => [],
    evaluate: async () => {
      throw new Error("must not modify page");
    },
  });
  Object.assign(context, {
    newCDPSession: async () =>
      snapshotSession(() =>
        ["e1", "e2", "e3", "f1e1"].map((ref) => [ref, { editable: ref !== "e3", labeled: ref === "e1" }]),
      ),
  });
  const tab = createBrowserClient(native).tabs.get(page._guid);
  const snapshot = JSON.parse(await tab.dom_cua.get_visible_dom());
  assert.equal(snapshot[0].name, "A label");
  assert.equal(snapshot[0].text, "<redacted>");
  assert.deepEqual(snapshot[1].children, ["<redacted>", { role: "text", text: "<redacted>" }]);
  assert.equal(snapshot[2].children[0].name, "Option a");
  assert.equal(snapshot[3].text, "Normal a label");
  assert.equal(snapshot[4].children[0].ref, "f1e1");
  assert.equal(snapshot[4].children[0].text, "<redacted>");
  assert.equal(original[0]?.text, "a");
});

test("snapshot metadata uses bounded batches and stale references fail closed", async () => {
  const { native, context } = mockBrowser();
  const page = await context.newPage();
  let refs: string[] = [];
  let reads = 0;
  let detached = 0;
  let stale = false;
  Object.assign(page, {
    frames: () => [],
    ariaSnapshotJSON: async () => refs.map((ref) => ({ ref, role: "generic", text: "private value" })),
  });
  Object.assign(context, {
    newCDPSession: async () => ({
      ...snapshotSession(() => {
        reads++;
        return stale ? [] : refs.map((ref) => [ref, { editable: true }]);
      }),
      detach: async () => {
        detached++;
      },
    }),
  });
  const tab = createBrowserClient(native).tabs.get(page._guid);
  for (const size of [200, 2000]) {
    refs = Array.from({ length: size }, (_, index) => `e${index}`);
    assert.equal((await tab.dom_cua.get_visible_dom()).includes("private value"), false);
  }
  assert.equal(reads, 2);
  assert.equal(detached, 2);
  stale = true;
  await assert.rejects(
    tab.dom_cua.get_visible_dom(),
    (error: Error) => error.message === "Snapshot redaction failed: a referenced element could not be verified",
  );
  assert.equal(detached, 3);
});

test("dev logs use native stored messages and filter mapped warning levels", async () => {
  const { native, context } = mockBrowser();
  const page = await context.newPage();
  const tab = createBrowserClient(native).tabs.get(page._guid);
  assert.deepEqual(
    (await tab.dev.logs({ levels: ["warn"] })).map((entry: any) => entry.message),
    ["warning message"],
  );
  assert.equal((await tab.dev.logs({ filter: "error", limit: 1 })).length, 1);
  assert.equal((await tab.dev.logs({ limit: 0 })).length, 0);
});

test(
  "native Chromium convenience layer keeps frames, handles, dialogs, snapshots and clipboard",
  { skip: !process.env.BROWSE_TEST_CHROMIUM },
  async () => {
    const { ensurePlaywright } = await import(
      new URL("../skills-seed/browse/scripts/playwright-runtime.mjs", import.meta.url).href
    );
    const { chromium } = await import(pathToFileURL(await ensurePlaywright()).href);
    const launched = await chromium.launch({ headless: !process.env.DISPLAY, args: ["--site-per-process"] });
    const directory = await mkdtemp(join(tmpdir(), "browse-client-"));
    let connected;
    try {
      const context = await launched.newContext();
      const original = await context.newPage();
      const { endpoint } = await launched.bind("client-test", { host: "127.0.0.1", port: 0 });
      connected = await chromium.connect(endpoint);
      const browser = createBrowserClient(connected, { outputDir: directory });
      const tab = browser.tabs.get(original._guid);
      const page = tab.playwright;
      const newer = await browser.tabs.new();
      if (process.env.DISPLAY) {
        for (const candidate of [page, newer.playwright]) {
          const session = await candidate.context().newCDPSession(candidate);
          await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
          await session.detach();
        }
      }
      await page.bringToFront();
      assert.equal((await browser.tabs.selected()).id, process.env.DISPLAY ? tab.id : newer.id);
      await newer.close();
      page.setDefaultTimeout(2000);
      assert.equal(page._guid, original._guid);
      await page.context().route("https://other.test/**", (route: any) =>
        route.fulfill({
          contentType: "text/html",
          body: '<input type="password" role="generic" value="sensitive-cross-origin">',
        }),
      );
      await page.route("https://example.test/**", (route: any) =>
        route.fulfill({
          contentType: "text/html",
          body: '<title>Native</title><input value="sensitive-input"><textarea>sensitive-area</textarea><input type="password" value="sensitive-password"><p>Normal a label</p><input value="a"><input type="radio" value="a"><input type="checkbox"><select><option>Keep options</option></select><button onclick="this.textContent=\'clicked\'">Outer</button><iframe srcdoc="<button>Inner</button><textarea>sensitive-frame</textarea>"></iframe><iframe src="https://other.test/child"></iframe>',
        }),
      );
      await tab.goto("https://example.test/");
      assert.equal(page.frames().length, 3);
      const crossFrame = page.frames().find((frame: any) => frame.url().startsWith("https://other.test/"));
      const crossSession = await page.context().newCDPSession(crossFrame);
      await crossSession.detach();
      await page
        .frameLocator("iframe[srcdoc]")
        .getByRole("button", { name: "Inner" })
        .dblclick({ modifiers: ["Shift"] });
      const handle = await page.evaluateHandle(() => ({ number: 7 }));
      assert.equal(await page.evaluate((value: any) => value.number, handle), 7);
      await handle.dispose();
      const before = await page
        .locator("input,textarea")
        .evaluateAll((elements: any[]) => elements.map((element) => element.value));
      const snapshot = await page.domSnapshot();
      assert.equal(snapshot.includes("sensitive-"), false);
      assert.equal(snapshot.includes("Inner"), true);
      assert.equal(snapshot.includes("Keep options"), true);
      assert.equal(snapshot.includes("Normal a label"), true);
      assert.deepEqual(
        await page.locator("input,textarea").evaluateAll((elements: any[]) => elements.map((element) => element.value)),
        before,
      );
      const flatten = (nodes: any[]): any[] => nodes.flatMap((node) => [node, ...flatten(node.children || [])]);
      const button = flatten(JSON.parse(snapshot)).find((node) => node.name === "Inner");
      assert.match(button.ref, /^f\d+e\d+$/);
      await tab.dom_cua.click({ node_id: button.ref });
      const second = flatten(JSON.parse(await tab.dom_cua.get_visible_dom())).find((node) => node.name === "Inner");
      assert.equal(second.ref, button.ref);
      await page.evaluate(() => {
        const button = (globalThis as any).document.querySelector("button");
        button.onclick = () => (globalThis as any).alert("automatic");
      });
      await page.getByRole("button", { name: "Outer" }).click();
      const dialogPromise = tab.getJsDialog({ timeoutMs: 2000 });
      const clickPromise = page.getByRole("button", { name: "Outer" }).click();
      const dialog = await dialogPromise;
      assert.equal(dialog.type(), "alert");
      assert.equal(dialog.message(), "automatic");
      await dialog.accept();
      await clickPromise;
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await tab.clipboard.writeText("text clipboard");
      assert.equal(await tab.clipboard.readText(), "text clipboard");
      await tab.clipboard.write([
        {
          entries: [
            { mimeType: "text/plain", text: "rich clipboard" },
            { mimeType: "text/html", text: "<b>rich clipboard</b>" },
          ],
        },
      ]);
      const clipboard = await tab.clipboard.read();
      assert.equal(clipboard[0].entries.find((entry: any) => entry.mimeType === "text/plain").text, "rich clipboard");
      await page.setContent(
        '<label for="native-target">Native label <input value="secret-native"></label><input id="native-target" value="secret-native-target"><label>Mixed label <input value="secret-mixed"><textarea>secret-mixed-area</textarea></label><label for="rich-target">Rich label <div contenteditable>secret-rich-label</div></label><input id="rich-target"><input id="source" value="secret-source"><input aria-label="Safe label" aria-labelledby="source" value="secret-target"><label id="nested-label">Label <input value="secret-inner"></label><input aria-labelledby="nested-label"><span id="shadow-label"></span><input aria-label="Safe shadow label" aria-labelledby="shadow-label"><span id="chain-label" aria-labelledby="source"></span><input aria-label="Safe chain label" aria-labelledby="chain-label"><span id="clean-label">Clean label</span><input aria-label="Lower priority label" aria-labelledby="clean-label" value="secret-clean">',
      );
      await page.locator("#shadow-label").evaluate((element: any) => {
        element.attachShadow({ mode: "open" }).innerHTML = '<input value="secret-shadow">';
      });
      const labelSnapshot = JSON.stringify(await page.ariaSnapshotJSON({ mode: "ai" }));
      assert.equal(labelSnapshot.includes('"name":"secret-source"'), true);
      assert.equal(labelSnapshot.includes('"name":"Label secret-inner"'), true);
      assert.equal(labelSnapshot.includes('"name":"secret-shadow"'), true);
      for (const secret of ["secret-native", "secret-mixed-area", "secret-rich-label"])
        assert.equal(
          flatten(JSON.parse(labelSnapshot)).some((node) => node.name?.includes(secret)),
          true,
          secret,
        );
      const safeLabels = await page.domSnapshot();
      assert.equal(safeLabels.includes("secret-"), false);
      assert.equal(safeLabels.includes('"name": "Clean label"'), true);
      for (const { slot, role, prefix } of [
        { slot: "<slot></slot>", role: "", prefix: "Account " },
        { slot: "<span><slot></slot></span>", role: "", prefix: "Account " },
        { slot: "<slot></slot>", role: 'role="generic"', prefix: "" },
        { slot: "<span><slot></slot></span>", role: 'role="generic"', prefix: "" },
      ]) {
        await page.setContent(`<div id="host"><input ${role} value="SLOT_SECRET"></div>`);
        await page.evaluate(
          ({ slot, prefix }: { slot: string; prefix: string }) => {
            const host = (globalThis as any).document.getElementById("host");
            host.attachShadow({ mode: "open" }).innerHTML =
              `<span id="label">${prefix}${slot}</span><input aria-labelledby="label" value="TARGET_SECRET"><span id="static">Static shadow label</span><input aria-labelledby="static" value="STATIC_SECRET">`;
          },
          { slot, prefix },
        );
        const raw = JSON.stringify(await page.ariaSnapshotJSON({ mode: "ai" }));
        assert.equal(raw.includes("SLOT_SECRET"), true);
        if (prefix) assert.equal(raw.includes(`"name":"${prefix}SLOT_SECRET"`), true);
        const safe = await page.domSnapshot();
        for (const secret of ["SLOT_SECRET", "TARGET_SECRET", "STATIC_SECRET"])
          assert.equal(safe.includes(secret), false, secret);
        assert.equal(safe.includes('"name": "Static shadow label"'), true);
      }
      await page.setContent('<p>Public label</p><textarea disabled role="none">disabled-secret</textarea>');
      assert.equal((await page.domSnapshot()).includes("disabled-secret"), false);
      await page.setContent(
        '<p>Public label</p><label>Account name<input value="account-secret"></label><input type="password" role="generic" value="password-secret"><textarea role="generic">textarea-secret</textarea><input type="text" role="button" value="button-secret"><input type="submit" value="submit-secret" title="Public tooltip" placeholder="Public placeholder"><input type="submit" id="self-label" aria-labelledby="self-label" value="self-secret"><span id="static-label">Linked label</span><input aria-labelledby="static-label" value="linked-secret"><div contenteditable="true" role="button">rich-secret<b>bold-secret</b><a href="https://example.test/secret">link-secret</a></div><div contenteditable="true" aria-label="Rich editor"><p>paragraph-secret</p></div><div contenteditable="true" role="none">flattened-secret</div><select aria-label="Ordinary choices"><option>Public option</option></select>',
      );
      await page.evaluate(() => {
        const host = (globalThis as any).document.createElement("div");
        (globalThis as any).document.body.append(host);
        host.attachShadow({ mode: "open" }).innerHTML = '<div contenteditable role="none">shadow-secret</div>';
      });
      const raw = JSON.stringify(await page.ariaSnapshotJSON({ mode: "ai" }));
      assert.equal(raw.includes("password-secret"), true);
      const redacted = await page.domSnapshot();
      assert.equal(redacted.includes("-secret"), false);
      assert.equal(redacted.includes('"name": "Account name"'), true);
      for (const label of [
        "Public label",
        "Account name",
        "Linked label",
        "Rich editor",
        "Ordinary choices",
        "Public option",
      ])
        assert.equal(redacted.includes(label), true, label);
      assert.equal(await page.locator('input[type="password"]').inputValue(), "password-secret");
      assert.equal(await page.locator("textarea").inputValue(), "textarea-secret");
      await assert.rejects(
        domSnapshot(
          {
            ariaSnapshotJSON: async (options: unknown) => {
              const snapshot = await page.ariaSnapshotJSON(options);
              await page
                .locator("input")
                .first()
                .evaluate((element: any) => element.remove());
              return snapshot;
            },
            _guid: page._guid,
            context: () => page.context(),
            frames: () => page.frames(),
            mainFrame: () => page.mainFrame(),
          },
          { timeout: 100 },
        ),
        /Snapshot redaction failed: a referenced element could not be verified/,
      );
      for (const fields of [20, 200, 1000]) {
        const html = Array.from(
          { length: fields / 20 },
          (_, branch) =>
            Array.from(
              { length: 20 },
              (_, depth) => `<div role="group" aria-label="Group ${branch}-${depth}"><input value="scaling-secret">`,
            ).join("") + "</div>".repeat(20),
        ).join("");
        await page.setContent(html);
        const commands: string[] = [];
        const measuredPage = {
          _guid: page._guid,
          frames: () => page.frames(),
          mainFrame: () => page.mainFrame(),
          ariaSnapshotJSON: (options: unknown) => page.ariaSnapshotJSON(options),
          context: () => ({
            newCDPSession: async (target: unknown) => {
              const session = await page.context().newCDPSession(target === measuredPage ? page : target);
              return {
                detach: () => session.detach(),
                send: async (method: string, params: unknown) => {
                  commands.push(method);
                  return session.send(method, params);
                },
              };
            },
          }),
        };
        const snapshot = await domSnapshot(measuredPage);
        assert.equal(snapshot.includes("scaling-secret"), false);
        assert.equal((snapshot.match(/"text": "<redacted>"/g) || []).length, fields);
        assert.deepEqual(commands, ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
      }
      const png = await page.screenshot();
      await tab.clipboard.write([{ entries: [{ mimeType: "image/png", base64: png.toString("base64") }] }]);
      const image = (await tab.clipboard.read())[0].entries.find((entry: any) => entry.mimeType === "image/png");
      assert.equal(Buffer.from(image.base64, "base64").subarray(1, 4).toString(), "PNG");
      const path = await tab.screenshot({ fullPage: true });
      assert.equal((await readFile(path)).subarray(1, 4).toString(), "PNG");
      assert.equal(Buffer.isBuffer(await page.screenshot()), true);
    } finally {
      await connected?.close();
      await launched.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
