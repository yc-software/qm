import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("confetti celebrates only the highest supported effort and respects reduced motion", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
    appType: "custom",
  });
  const dom = new JSDOM('<button><span class="effort-peak">Extra high</span></button>');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  let reducedMotion = false;
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: reducedMotion }) });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const completions: Array<() => void> = [];
  Object.defineProperty(dom.window.HTMLElement.prototype, "animate", {
    value: () => ({ finished: new Promise<void>((resolve) => completions.push(resolve)) }),
  });
  const button = dom.window.document.querySelector("button")!;
  const label = button.querySelector("span")!;
  label.getBoundingClientRect = () => ({ left: 100, top: 100, width: 60, height: 20 }) as DOMRect;
  try {
    const { burstEffortConfetti } = await vite.ssrLoadModule("/src/effort-confetti.ts");
    let selectedLevel = "xhigh";
    let selectedHarness = "codex";
    button.addEventListener("click", (event) => burstEffortConfetti(event, selectedLevel, selectedHarness));
    const finishBurst = async (): Promise<void> => {
      completions.splice(0).forEach((complete) => complete());
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(dom.window.document.querySelector(".effort-confetti"), null);
    };
    for (const [harness, top] of [
      ["pi", "ultracode"],
      ["claude", "max"],
      ["codex", "xhigh"],
    ]) {
      selectedHarness = harness;
      for (const level of ["high", "auto", top]) {
        selectedLevel = level;
        button.click();
        assert.equal(dom.window.document.querySelectorAll(".effort-confetti > span").length, level === top ? 14 : 0);
        await finishBurst();
      }
    }
    for (const [harness, level] of [
      ["opencode", "auto"],
      ["codex", "ultracode"],
      ["pi", "max"],
    ]) {
      selectedHarness = harness;
      selectedLevel = level;
      button.click();
      assert.equal(dom.window.document.querySelector(".effort-confetti"), null);
    }
    selectedHarness = "codex";
    selectedLevel = "xhigh";
    reducedMotion = true;
    button.click();
    assert.equal(dom.window.document.querySelector(".effort-confetti"), null);
    reducedMotion = false;
    button.click();
    assert.equal(dom.window.document.querySelectorAll(".effort-confetti > span").length, 14);
    assert.equal(dom.window.document.querySelector(".effort-confetti")?.getAttribute("aria-hidden"), "true");
    button.click();
    assert.equal(completions.length, 14);
    await finishBurst();
  } finally {
    await vite.close();
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
