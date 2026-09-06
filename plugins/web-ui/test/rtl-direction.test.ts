import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const messageMarkdown = readFileSync(new URL("../src/message-markdown.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("composer text entry selects direction from its content", () => {
  assert.match(composer, /<textarea\s+class="composer-input"\s+dir="auto"/);
  assert.match(composer, /<textarea\s+class="paste-dialog-text"\s+dir="auto"/);
  assert.match(composer, /class="queued-text" dir="auto"/);
});

test("settled and streaming transcript blocks select direction from their content", () => {
  assert.match(chat, /import \{ markdown \} from "\.\/message-markdown"/);
  assert.match(
    messageMarkdown,
    /<markdown-block\s+dir="auto"\s+\.content=\$\{escapeLoneDollars\(normalizePlainTextFences\(text\)\)\}/,
  );
  assert.match(chat, /escapedSegs\.map\(\(seg\) => html`<markdown-block dir="auto"/);
  assert.match(chat, /class="stream-tail"\s+dir="auto"/);
  assert.match(chat, /class="streaming-text \$\{isStreaming \? "live-stream" : ""\}" dir="auto"/);
});

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
    const dom = new JSDOM('<main><textarea dir="auto"></textarea><markdown-block dir="auto"></markdown-block></main>');
    const textarea = dom.window.document.querySelector("textarea")!;
    const block = dom.window.document.querySelector("markdown-block") as HTMLElement;
    textarea.value = content;
    block.textContent = content;
    assert.equal(textarea.dir, "auto");
    assert.equal(block.dir, "auto");
    assert.equal(dom.window.document.querySelector("main")!.getAttribute("dir"), null);
  });
}
