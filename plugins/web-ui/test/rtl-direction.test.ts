import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

test("search group headers select direction from the authored session title", async () => {
  const dom = new JSDOM('<!doctype html><main id="host"></main>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const [{ render }, { searchGroup }] = await Promise.all([import("lit"), import("../src/search-group.ts")]);
  const host = dom.window.document.querySelector<HTMLElement>("#host")!;
  render(searchGroup("مراجعة الإطلاق", false, "Today"), host);
  const title = host.querySelector<HTMLElement>(".chat-search-group > b")!;
  assert.equal(title.textContent, "مراجعة الإطلاق");
  assert.equal(title.dir, "auto");
  assert.equal(host.querySelector(".chat-search-group")!.getAttribute("dir"), null);
  dom.window.close();
});

test("fork origin isolates the authored title from its fixed label", async () => {
  const dom = new JSDOM('<main id="host"></main>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const [{ render }, { forkOriginView }] = await Promise.all([import("lit"), import("../src/fork-origin.ts")]);
  const host = dom.window.document.querySelector<HTMLElement>("#host")!;
  render(
    forkOriginView({
      title: "مراجعة الإطلاق",
      expanded: false,
      navigate() {},
      toggle() {},
    }),
    host,
  );
  const title = host.querySelector(".fork-origin-badge bdi")!;
  assert.equal(title.textContent, "مراجعة الإطلاق");
  assert.equal(host.querySelector(".fork-origin-row")!.getAttribute("dir"), null);
  dom.window.close();
});

for (const content of [
  "مرحبا بالعالم",
  "שלום https://example.com user_42 10:30",
  "Hello https://example.com user_42 10:30",
]) {
  test(`automatic direction remains content-level for ${content}`, () => {
    const dom = new JSDOM('<main><textarea dir="auto"></textarea><qm-markdown dir="auto"></qm-markdown></main>');
    const textarea = dom.window.document.querySelector("textarea")!;
    const block = dom.window.document.querySelector("qm-markdown") as HTMLElement;
    textarea.value = content;
    block.textContent = content;
    assert.equal(textarea.dir, "auto");
    assert.equal(block.dir, "auto");
    assert.equal(dom.window.document.querySelector("main")!.getAttribute("dir"), null);
  });
}
