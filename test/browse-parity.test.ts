import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const endpoint = process.env.BROWSE_TEST_CDP;
const scripts = new URL("../skills-seed/browse/scripts/", import.meta.url);
const load = (name: string) => import(new URL(name, scripts).href);
const pngSize = (bytes: Buffer) => {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const state = (page: any) => page.evaluate("window.fixtureState");
const center = async (locator: any) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("full browser protocol behavioral parity", { skip: !endpoint, timeout: 600000 }, async (t) => {
  const { startFixture } = await import(new URL("./fixtures/browse-parity.mjs", import.meta.url).href);
  const fixture = await startFixture({
    mainOrigin: process.env.BROWSE_TEST_BASE,
    crossOrigin: process.env.BROWSE_TEST_CROSS_ORIGIN,
  });
  t.after(() => fixture.close());
  const base = process.env.BROWSE_TEST_BASE || fixture.mainUrl;
  const { startBrowserService } = await load("browser-service.mjs");
  const service = await startBrowserService(endpoint, { provider: Boolean(process.env.BROWSE_TEST_BASE) });
  t.after(() => service.close());
  const { ensurePlaywright } = await load("playwright-runtime.mjs");
  const { chromium } = await import(pathToFileURL(await ensurePlaywright()).href);
  const native = await chromium.connect(service.endpoint);
  t.after(() => native.close());
  const requestedDeviceScaleFactor = 2;
  const context = await native.newContext({
    acceptDownloads: true,
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: requestedDeviceScaleFactor,
  });
  t.after(() => context.close());
  const { createBrowserClient } = await load("browser-client.mjs");
  const client = createBrowserClient(native, { context });
  const scenario = async (name: string, run: (tab: any, page: any) => Promise<void>, path = "/") => {
    await t.test(name, { timeout: process.env.BROWSE_TEST_BASE ? 90000 : 25000 }, async () => {
      const tab = await client.tabs.new();
      try {
        tab.playwright.setDefaultTimeout(7000);
        await tab.goto(base + path);
        await tab.playwright.waitForFunction("window.fixtureState?.events.some(e => e.type === 'ready')");
        await run(tab, tab.playwright);
      } finally {
        await tab.close();
      }
    });
  };

  await scenario("native Browser, Page, Context and object prototypes are not narrowed", async (tab, page) => {
    assert.equal(client.playwright, native);
    assert.equal(
      page,
      context.pages().find((candidate: any) => candidate === page),
    );
    assert.equal(Object.getPrototypeOf(page), Object.getPrototypeOf(context.pages()[0]));
    assert.equal(client.tabs.get(tab.id), tab);
    await page.bringToFront();
    assert.equal(await client.tabs.selected(), tab);
    assert.ok((await client.tabs.list()).some((entry: any) => entry.id === tab.id));
    const handle = await page.evaluateHandle(({ value }: { value: number }) => ({ result: value * 2, array: [1, 2] }), {
      value: 21,
    });
    assert.equal(await (await handle.getProperty("result")).jsonValue(), 42);
    assert.equal(await page.evaluate((object: { result: number }) => object.result + 1, handle), 43);
    await handle.dispose();
    const element = await page.locator("#click-target").elementHandle();
    assert.equal(await element.evaluate((node: any) => node.tagName), "BUTTON");
    await element.click();
    await element.dispose();
    assert.ok(
      (await state(page)).events.some(
        (event: any) => event.type === "click" && event.target === "click-target" && event.trusted,
      ),
    );
  });

  await scenario("nested same-origin and cross-site OOPIF frames retain focus and native input", async (_tab, page) => {
    const targets = [
      page.frameLocator("#same-frame"),
      page.frameLocator("#cross-frame"),
      page.frameLocator("#same-frame").frameLocator("#nested-same-frame"),
      page.frameLocator("#same-frame").frameLocator("#nested-cross-frame"),
      page.frameLocator("#cross-frame").frameLocator("#nested-same-frame"),
      page.frameLocator("#cross-frame").frameLocator("#nested-cross-frame"),
    ];
    for (const [index, frame] of targets.entries()) {
      await frame.getByRole("button", { name: "Click target", exact: true }).click();
      await frame.getByLabel("Text", { exact: true }).fill(`frame-${index}-世界`);
      assert.equal(await frame.locator("#text-input").inputValue(), `frame-${index}-世界`);
      assert.ok(
        await frame
          .locator("#click-target")
          .evaluate((element: any) =>
            (element.ownerDocument.defaultView! as any).fixtureState.events.some(
              (event: any) => event.type === "click" && event.target === "click-target" && event.trusted,
            ),
          ),
      );
    }
    const session = await context.newCDPSession(page);
    const { targetInfos } = await session.send("Target.getTargets");
    assert.ok(
      targetInfos.some((target: any) => target.type === "iframe" && target.url.includes("/frame?label=")),
      "cross-site frame must actually be out of process",
    );
    await session.detach();
  });

  await scenario("scrolled transformed frame owners survive reload and cross-origin swap", async (_tab, page) => {
    await page.locator("#cross-frame").evaluate((element: any) => {
      element.style.transform = "translate(25px, 10px) scale(.85)";
    });
    const frame = page.frameLocator("#cross-frame");
    await frame.getByRole("button", { name: "Click target", exact: true }).click();
    const owner = page.locator("#cross-frame");
    const beforeReload = page
      .frames()
      .find((candidate: any) => new URL(candidate.url()).searchParams.get("label") === "cross");
    assert.ok(beforeReload);
    await Promise.all([
      beforeReload.waitForURL("**&reload=1"),
      owner.evaluate((element: any) => {
        element.src += "&reload=1";
      }),
    ]);
    await frame.getByLabel("Text", { exact: true }).fill("after reload");
    assert.equal(await frame.locator("#text-input").inputValue(), "after reload");
    await owner.evaluate((element: any) => {
      element.src = "/frame?label=swapped&nested=1";
    });
    await frame.getByRole("heading", { name: "Parity swapped", exact: true }).waitFor();
    await frame.frameLocator("#nested-cross-frame").getByLabel("Text", { exact: true }).fill("after process swap");
    assert.equal(
      await frame.frameLocator("#nested-cross-frame").locator("#text-input").inputValue(),
      "after process swap",
    );
  });

  await scenario("selectors, regex, filters, collections, states and complete native forms", async (_tab, page) => {
    assert.equal(await page.getByRole("button", { name: /^Click tar/ }).count(), 1);
    assert.equal(
      await page
        .locator("section")
        .filter({ has: page.locator("#click-target") })
        .getByText("Pointer", { exact: true })
        .innerText(),
      "Pointer",
    );
    assert.equal(
      await page
        .locator("#pointer")
        .filter({ hasNot: page.locator("input") })
        .count(),
      1,
    );
    assert.equal(await page.locator("#pointer").filter({ hasText: /Click/, hasNotText: "absent" }).count(), 1);
    assert.equal(
      await page.locator("#click-target").and(page.getByRole("button")).or(page.locator("#missing")).count(),
      1,
    );
    assert.deepEqual(await page.locator("#select option").allTextContents(), ["Alpha", "Beta"]);
    assert.equal((await page.locator("#select option").all()).length, 2);
    assert.equal(await page.locator("#select option").last().getAttribute("value"), "b");
    assert.equal(await page.locator("#select option").nth(0).textContent(), "Alpha");
    assert.equal(
      await page
        .locator("#select option")
        .evaluateAll((elements: any[]) => elements.map((element) => element.value).join(",")),
      "a,b",
    );
    await page.getByLabel("Checkbox", { exact: true }).check();
    assert.equal(await page.locator("#checkbox").isChecked(), true);
    await page.locator("#checkbox").uncheck();
    await page.locator("#checkbox").setChecked(true);
    await page.getByLabel("Radio A", { exact: true }).check();
    await page.getByLabel("Radio B", { exact: true }).check();
    assert.equal(await page.locator("#radio-a").isChecked(), false);
    assert.equal(await page.locator("#radio-b").isChecked(), true);
    assert.deepEqual(await page.locator("#select").selectOption({ label: "Beta" }), ["b"]);
    assert.deepEqual(await page.locator("#select").selectOption({ index: 0 }), ["a"]);
    assert.deepEqual(await page.locator("#multi-select").selectOption(["a", "c"]), ["a", "c"]);
    assert.deepEqual(await page.locator("#multi-select").selectOption([]), []);
    await page.getByRole("textbox", { name: "Editable text", exact: true }).fill("rich 世界");
    assert.equal(await page.locator("#editable").innerText(), "rich 世界");
    await page.locator("#add-delayed").click();
    await page.locator("#delayed-target").waitFor({ state: "visible" });
    assert.equal(await page.locator("#delayed-target").isEnabled(), true);
    const old = await page.locator("#rerender-target").elementHandle();
    await page.locator("#rerender").click();
    await old.waitForElementState("hidden");
    assert.equal(await page.locator("#rerender-target").getAttribute("data-generation"), "1");
    await old.dispose();
    await page.getByRole("button", { name: "Deep shadow button", exact: true }).click();
    await page.getByLabel("Shadow input", { exact: true }).fill("shadow text");
    assert.equal(await page.locator("#shadow-input").inputValue(), "shadow text");
  });

  await scenario("native right, middle, double, modified click, hover, drag and wheel", async (_tab, page) => {
    const target = page.locator("#click-target");
    await target.click({ button: "right" });
    await target.click({ button: "middle" });
    await target.dblclick({ modifiers: ["Shift"] });
    await target.click({ modifiers: ["Control", "Alt"], force: true });
    const events = (await state(page)).events;
    assert.ok(events.some((event: any) => event.type === "contextmenu" && event.button === 2 && event.trusted));
    assert.ok(events.some((event: any) => event.type === "auxclick" && event.button === 1 && event.trusted));
    assert.ok(
      events.some((event: any) => event.type === "dblclick" && event.detail === 2 && event.shiftKey && event.trusted),
    );
    assert.ok(events.some((event: any) => event.type === "click" && event.ctrlKey && event.altKey && event.trusted));
    await page.locator("#hover-target").hover();
    assert.equal(await page.locator("#hover-action").isVisible(), true);
    await page.locator("#hover-action").click();
    await page.locator("#drag-source").dragTo(page.locator("#drop-target"));
    assert.equal((await state(page)).values.drop, "parity-payload");
    await page.locator("#scroll-container").hover();
    await page.mouse.wheel(250, 320);
    await page.waitForFunction(
      "document.querySelector('#scroll-container').scrollTop > 0 && document.querySelector('#scroll-container').scrollLeft > 0",
    );
  });

  await scenario("keyboard down/up, shortcuts, sequential keys, Unicode and beforeinput", async (_tab, page) => {
    const input = page.locator("#text-input");
    await input.click();
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Shift");
    await page.keyboard.type("bc");
    assert.equal(await input.inputValue(), "Abc");
    await input.press("ControlOrMeta+A");
    await page.keyboard.insertText("世界 🧭");
    await input.pressSequentially(" xy");
    assert.equal(await input.inputValue(), "世界 🧭 xy");
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator("#textarea")
        .evaluate((element: any) => element === (globalThis as any).document.activeElement),
      true,
    );
    const events = (await state(page)).events;
    assert.ok(
      events.some((event: any) => event.type === "keydown" && event.shiftKey && event.key === "A" && event.trusted),
    );
    assert.ok(
      events.some(
        (event: any) =>
          event.type === "beforeinput" && event.inputType === "insertText" && event.data === "世界 🧭" && event.trusted,
      ),
    );
    assert.ok(events.some((event: any) => event.type === "keyup" && event.key === "Shift" && !event.shiftKey));
  });

  await scenario("popup and navigation waits run concurrently with actions, history and reload", async (tab, page) => {
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("#popup-link").click()]);
    try {
      await popup.waitForLoadState("domcontentloaded");
      assert.equal(await popup.title(), "Parity popup");
      assert.equal(await popup.opener(), page);
      assert.ok((await client.tabs.list()).some((entry: any) => entry.url.endsWith("/popup")));
    } finally {
      await popup.close();
    }
    await Promise.all([page.waitForURL("**/navigation?step=arrived"), page.locator("#navigate").click()]);
    assert.equal(await tab.title(), "Parity navigation");
    await tab.back();
    assert.equal(new URL(page.url()).pathname, "/");
    await tab.forward();
    assert.equal(new URL(page.url()).pathname, "/navigation");
    await Promise.all([
      page.waitForURL((url: URL) => url.pathname === "/"),
      tab.cua.click({ x: 20, y: 20, button: 4 }),
    ]);
    assert.equal(await page.title(), "Parity main");
    assert.equal(page.frames().length, 7);
    await Promise.all([page.waitForURL("**/navigation?step=arrived"), tab.cua.click({ x: 20, y: 20, button: 5 })]);
    assert.equal(await page.title(), "Parity navigation");
    await tab.reload();
    await page.waitForLoadState("load");
    await Promise.all([page.waitForURL("**?step=1"), page.locator("#history-push").click()]);
    await Promise.all([page.waitForURL("**#navigation"), page.locator("#hash-link").click()]);
    assert.equal(new URL(page.url()).hash, "#navigation");
  });

  await scenario(
    "dialogs auto-dismiss without handlers and explicit accept/dismiss retain results",
    async (tab, page) => {
      await page.locator("#dialog-confirm").click();
      assert.equal((await state(page)).dialogs.confirm, false);
      await Promise.all([
        page.waitForEvent("dialog").then(async (dialog: any) => {
          assert.equal(dialog.type(), "prompt");
          assert.equal(dialog.defaultValue(), "default answer");
          await dialog.accept("answer 世界");
        }),
        page.locator("#dialog-prompt").click(),
      ]);
      assert.equal((await state(page)).dialogs.prompt, "answer 世界");
      await Promise.all([
        tab.getJsDialog().then((dialog: any) => dialog.accept()),
        page.locator("#dialog-confirm").click(),
      ]);
      assert.equal((await state(page)).dialogs.confirm, true);
      await Promise.all([
        page.waitForEvent("dialog").then((dialog: any) => dialog.dismiss()),
        page.locator("#dialog-alert").click(),
      ]);
      assert.equal((await state(page)).dialogs.alert, "closed");
      await page.locator("#beforeunload").check();
      await Promise.all([
        page.waitForEvent("dialog").then(async (dialog: any) => {
          assert.equal(dialog.type(), "beforeunload");
          await dialog.dismiss();
        }),
        page.close({ runBeforeUnload: true }),
      ]);
      assert.equal(page.isClosed(), false);
      await page.locator("#beforeunload").uncheck();
    },
  );

  await scenario("buffer uploads, multi-file chooser and clearing preserve exact bytes", async (_tab, page) => {
    const file = { name: "parity.txt", mimeType: "text/plain", buffer: Buffer.from("payload 世界\n") };
    await page.locator("#file").setInputFiles(file);
    await page.waitForFunction("window.fixtureState.files.file?.length === 1");
    assert.deepEqual(
      (await state(page)).files.file.map(({ name, type, text, size }: any) => ({ name, type, text, size })),
      [{ name: file.name, type: file.mimeType, text: file.buffer.toString(), size: file.buffer.length }],
    );
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#choose-files").click()]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles([file, { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") }]);
    await page.waitForFunction("window.fixtureState.files['hidden-files']?.length === 2");
    assert.deepEqual(
      (await state(page)).files["hidden-files"].map((item: any) => item.text),
      ["payload 世界\n", "second"],
    );
    await page.locator("#file").setInputFiles([]);
    await page.waitForFunction("window.fixtureState.files.file?.length === 0");
    assert.equal(await page.locator("#file").evaluate((element: any) => element.files!.length), 0);
  });

  await scenario("native download event, stream and saveAs return real file bytes", async (_tab, page) => {
    const dir = await mkdtemp(join(tmpdir(), "browse-parity-"));
    try {
      for (const [selector, name, text] of [
        ["#download-get", "parity-get.txt", "parity get download\n"],
        ["#download-post", "parity-post.txt", "payload=parity+post+download"],
        ["#download-blob", "parity-blob.txt", "parity blob download\n"],
      ] as const) {
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator(selector).click()]);
        assert.equal(download.suggestedFilename(), name);
        await download.saveAs(join(dir, name));
        assert.equal(await download.failure(), null);
        assert.equal(await readFile(join(dir, name), "utf8"), text);
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), text);
        await download.delete();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await scenario(
    "viewport, full-page, clip and element screenshots produce correct PNG dimensions",
    async (_tab, page) => {
      await page.setViewportSize({ width: 900, height: 700 });
      assert.deepEqual(await page.evaluate("({ width: innerWidth, height: innerHeight })"), {
        width: 900,
        height: 700,
      });
      assert.deepEqual(pngSize(await page.screenshot()), {
        width: Math.round(900 * requestedDeviceScaleFactor),
        height: Math.round(700 * requestedDeviceScaleFactor),
      });
      assert.deepEqual(pngSize(await page.screenshot({ scale: "css" })), { width: 900, height: 700 });
      await page.locator("body").evaluate((element: any) => {
        element.style.width = "1400px";
      });
      const full = pngSize(await page.screenshot({ fullPage: true, scale: "css" }));
      assert.ok(full.height > 700);
      assert.ok(full.width >= 1400);
      assert.deepEqual(pngSize(await page.screenshot({ clip: { x: 0, y: 0, width: 120, height: 80 }, scale: "css" })), {
        width: 120,
        height: 80,
      });
      const locator = page.locator("#click-target");
      const element = pngSize(await locator.screenshot({ scale: "css" }));
      const box = await locator.boundingBox();
      assert.ok(Math.abs(element.width - box.width) <= 2);
      assert.ok(Math.abs(element.height - box.height) <= 2);
    },
  );

  await scenario(
    "context cookies/storage/permissions and network route/request/response/console events",
    async (_tab, page) => {
      await context.addCookies([{ name: "parity-cookie", value: "cookie-value", url: base }]);
      assert.ok(
        (await context.cookies(base)).some(
          (cookie: any) => cookie.name === "parity-cookie" && cookie.value === "cookie-value",
        ),
      );
      await page.evaluate(() => localStorage.setItem("parity-key", "storage-value"));
      assert.ok(
        (await context.storageState()).origins.some((origin: any) =>
          origin.localStorage.some((item: any) => item.name === "parity-key" && item.value === "storage-value"),
        ),
      );
      await context.grantPermissions(["geolocation"], { origin: base });
      assert.equal(
        await page.evaluate(async () => (await (navigator as any).permissions.query({ name: "geolocation" })).state),
        "granted",
      );
      const [request, response] = await Promise.all([
        page.waitForRequest("**/api/echo?source=post"),
        page.waitForResponse("**/api/echo?source=post"),
        page.locator("#network-post").click(),
      ]);
      assert.equal(request.method(), "POST");
      assert.deepEqual(request.postDataJSON(), { message: "parity post" });
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).headers["x-parity-request"], "present");
      await page.route("**/api/echo?source=get", (route: any) =>
        route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ intercepted: true }) }),
      );
      const [routed] = await Promise.all([
        page.waitForResponse("**/api/echo?source=get"),
        page.locator("#network-get").click(),
      ]);
      assert.equal(routed.status(), 201);
      assert.deepEqual(await routed.json(), { intercepted: true });
      await page.unroute("**/api/echo?source=get");
      const [message] = await Promise.all([
        page.waitForEvent("console"),
        page.evaluate(() => console.log("parity console", { value: 7 })),
      ]);
      assert.equal(message.type(), "log");
      assert.deepEqual(await message.args()[1].jsonValue(), { value: 7 });
      await context.clearPermissions();
      await context.clearCookies();
    },
  );

  await scenario("input types, semantic builders and disabled/hidden/detached actionability", async (_tab, page) => {
    const input = page.locator("#text-input");
    await input.evaluate((element: any) => {
      element.placeholder = "Type a value";
      element.dataset.testid = "semantic-input";
      element.title = "Input details";
    });
    assert.equal(await page.getByPlaceholder(/Type a/).count(), 1);
    assert.equal(await page.getByTestId("semantic-input").count(), 1);
    assert.equal(await page.getByTitle("Input details").count(), 1);
    for (const [type, value] of [
      ["password", "private value"],
      ["date", "2026-10-14"],
      ["number", "12.5"],
      ["text", "normal value"],
    ]) {
      await input.evaluate((element: any, type: string) => {
        element.type = type;
      }, type);
      await input.fill(value);
      assert.equal(await input.inputValue(), value);
    }
    await input.evaluate((element: any) => {
      element.disabled = true;
    });
    assert.equal(await input.isDisabled(), true);
    await assert.rejects(input.fill("must not write", { timeout: 150 }), /not enabled|Timeout/);
    assert.equal(await input.inputValue(), "normal value");
    await input.evaluate((element: any) => {
      element.disabled = false;
      element.readOnly = true;
    });
    assert.equal(await input.isEditable(), false);
    await input.evaluate((element: any) => {
      element.readOnly = false;
      element.hidden = true;
    });
    await input.waitFor({ state: "hidden" });
    assert.equal(await input.isVisible(), false);
    await input.evaluate((element: any) => {
      element.remove();
    });
    await input.waitFor({ state: "detached" });
    assert.equal(await input.count(), 0);
  });

  await scenario("coordinate movement, drag, scroll and held-key cleanup are native", async (tab, page) => {
    const hover = await center(page.locator("#hover-target"));
    await tab.cua.move(hover);
    assert.equal(await page.locator("#hover-action").isVisible(), true);
    await page.locator("#drag-source").scrollIntoViewIfNeeded();
    const source = await center(page.locator("#drag-source"));
    const target = await center(page.locator("#drop-target"));
    await tab.cua.drag({ path: [source, { x: source.x + 10, y: source.y }, target, target], keys: ["SHIFT"] });
    assert.equal((await state(page)).values.drop, "parity-payload");
    const scroll = await center(page.locator("#scroll-container"));
    await tab.cua.scroll({ ...scroll, scrollX: 100, scrollY: 250 });
    await page.waitForFunction("document.querySelector('#scroll-container').scrollTop > 0");
    await assert.rejects(tab.cua.click({ x: "invalid", y: 0, keypress: ["SHIFT"] }), /number|float|x/);
    await page.locator("#text-input").click();
    await page.keyboard.type("a");
    assert.equal(await page.locator("#text-input").inputValue(), "a");
    const events = (await state(page)).events;
    assert.ok(
      events.some((event: any) => event.type === "keydown" && event.key === "a" && !event.shiftKey && event.trusted),
    );
  });

  await scenario("nested cross-origin uploads and downloads use actual byte payloads", async (_tab, page) => {
    const frame = page.frameLocator("#cross-frame").frameLocator("#nested-same-frame");
    await frame.locator("body").evaluate((body: any) => {
      const input = body.ownerDocument.createElement("input");
      input.type = "file";
      input.id = "frame-file";
      body.prepend(input);
      const anchor = body.ownerDocument.createElement("a");
      anchor.id = "frame-download";
      anchor.href = "/download";
      anchor.download = "frame.txt";
      anchor.textContent = "Frame download";
      body.prepend(anchor);
    });
    const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    await frame
      .locator("#frame-file")
      .setInputFiles({ name: "frame.bin", mimeType: "application/octet-stream", buffer: bytes });
    assert.deepEqual(
      await frame
        .locator("#frame-file")
        .evaluate(async (element: any) => Array.from(new Uint8Array(await element.files[0].arrayBuffer()))),
      [...bytes],
    );
    const [download] = await Promise.all([page.waitForEvent("download"), frame.locator("#frame-download").click()]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "parity get download\n");
    await download.delete();
  });

  await scenario("CUA, all-frame redacted snapshots, native references, DOM-CUA and clipboard", async (tab, page) => {
    const point = await center(page.locator("#click-target"));
    await tab.cua.click({ ...point, button: 3, keypress: ["SHIFT"] });
    await tab.cua.double_click(point);
    await page.locator("#text-input").click();
    await tab.cua.type({ text: "top-secret-parity" });
    await tab.cua.keypress({ keys: ["CTRL", "A"] });
    await tab.cua.type({ text: "redacted-top-value" });
    await page.frameLocator("#cross-frame").locator("#text-input").fill("redacted-frame-value");
    for (const frame of page.frames())
      await frame.locator("#state").evaluate((element: any) => {
        element.hidden = true;
      });
    const snapshot = await page.domSnapshot();
    assert.ok(!snapshot.includes("redacted-top-value"));
    assert.ok(!snapshot.includes("redacted-frame-value"));
    assert.ok(snapshot.includes("<redacted>"));
    assert.ok(snapshot.includes("Parity cross"));
    assert.ok(snapshot.includes("Parity same-nested-same"));
    const nodes: any[] = [];
    const visit = (node: any) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object") {
        nodes.push(node);
        Object.values(node).forEach(visit);
      }
    };
    visit(JSON.parse(await tab.dom_cua.get_visible_dom()));
    const targets = nodes.filter((node) => node.role === "button" && node.name === "Click target" && node.ref);
    assert.equal(targets.length, 7, "snapshot must expose actionable references from all seven frames");
    for (const target of targets) {
      assert.equal(await tab.dom_cua.locator(target.ref).innerText(), "Click target");
      await tab.dom_cua.click({ node_id: target.ref });
      await tab.dom_cua.double_click({ node_id: target.ref });
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.bringToFront();
    await tab.clipboard.writeText("clipboard 世界");
    assert.equal(await tab.clipboard.readText(), "clipboard 世界");
    await tab.clipboard.write([
      {
        entries: [
          { mimeType: "text/plain", text: "rich clipboard" },
          { mimeType: "text/html", text: "<b>rich clipboard</b>" },
        ],
      },
    ]);
    const clipboard = await tab.clipboard.read();
    assert.ok(
      clipboard.some((item: any) =>
        item.entries.some((entry: any) => entry.mimeType === "text/plain" && entry.text === "rich clipboard"),
      ),
    );
    assert.ok(
      clipboard.some((item: any) =>
        item.entries.some(
          (entry: any) => entry.mimeType === "text/html" && entry.text.includes("<b>rich clipboard</b>"),
        ),
      ),
    );
    await context.clearPermissions();
  });
});
