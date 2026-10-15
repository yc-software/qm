import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
const load = (name: string) => import(new URL(`../skills-seed/browse/scripts/${name}`, import.meta.url).href);
const endpoint = process.env.BROWSE_TEST_CDP;

test(
  "remote smart modifiers retain native input and explicit platform keys",
  { skip: !endpoint, timeout: 90000 },
  async (t) => {
    const { ensurePlaywright } = await load("playwright-runtime.mjs");
    const modulePath = await ensurePlaywright();
    const { chromium } = await import(pathToFileURL(modulePath).href);
    const daemon = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const cleanup: (() => unknown)[] = [() => daemon.close()];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
    });
    const { installBrowserInput } = await load("browser-input.mjs");
    const dispose = await installBrowserInput(daemon, modulePath);
    cleanup.push(dispose);
    const mac = daemon._connection.toImpl(daemon)._platform() === "mac";
    t.diagnostic(`Remote platform: ${mac ? "mac" : "non-mac"}`);
    const { endpoint: bound } = await daemon.bind("input-test", { host: "127.0.0.1", port: 0 });
    cleanup.push(() => daemon.unbind());
    const worker = await chromium.connect(bound);
    cleanup.push(() => worker.close());
    const context = await worker.newContext();
    cleanup.push(() => context.close());
    const page = await context.newPage();
    await page.goto("data:text/html,<input id=t><button id=b>Click</button><iframe srcdoc='<input id=t>'></iframe>");
    const input = page.locator("#t");
    const range = () => input.evaluate((e: any) => [e.selectionStart, e.selectionEnd]);
    await t.test("locator shortcut and Unicode use native selection replacement", async () => {
      await input.fill("Abc");
      await input.press("ControlOrMeta+A");
      assert.deepEqual(await range(), [0, 3]);
      await page.keyboard.insertText("世界 🧭");
      await input.pressSequentially(" xy");
      assert.equal(await input.inputValue(), "世界 🧭 xy");
    });
    await t.test("down/up aliases are paired and do not leave a held modifier", async () => {
      await input.fill("Abc");
      await page.keyboard.down("ControlOrMeta");
      await page.keyboard.press("a");
      await page.keyboard.up("ControlOrMeta");
      assert.deepEqual(await range(), [0, 3]);
      await page.keyboard.type("z");
      assert.equal(await input.inputValue(), "z");
    });
    await t.test("explicit Control and Meta preserve remote platform behavior", async () => {
      await input.fill("Abc");
      await input.press(mac ? "Meta+A" : "Control+A");
      assert.deepEqual(await range(), [0, 3]);
      if (mac) {
        await input.press("ArrowRight");
        await input.press("Control+A");
        assert.deepEqual(await range(), [0, 0]);
      }
    });
    await t.test("modified locator and coordinate clicks use the same platform", async () => {
      await page.evaluate(() => {
        (globalThis as any).clicks = [];
        (globalThis as any).document.querySelector("#b").addEventListener("click", (e: any) => {
          (globalThis as any).clicks.push([e.ctrlKey, e.metaKey]);
        });
      });
      await page.locator("#b").click({ modifiers: ["ControlOrMeta"] });
      const box = await page.locator("#b").boundingBox();
      await page.keyboard.down("ControlOrMeta");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.up("ControlOrMeta");
      await page.locator("#b").click();
      assert.deepEqual(await page.evaluate("window.clicks"), [
        [!mac, mac],
        [!mac, mac],
        [false, false],
      ]);
    });
    await t.test("frame shortcuts and newly created pages are covered", async () => {
      const child = page.frameLocator("iframe").locator("#t");
      await child.fill("child");
      await child.press("ControlOrMeta+A");
      await page.keyboard.insertText("frame");
      assert.equal(await child.inputValue(), "frame");
      const second = await context.newPage();
      try {
        await second.goto("data:text/html,<input>");
        await second.locator("input").fill("new");
        await second.locator("input").press("ControlOrMeta+A");
        await second.keyboard.insertText("page");
        assert.equal(await second.locator("input").inputValue(), "page");
      } finally {
        await second.close();
      }
    });
  },
);
