import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "http://localhost" });
for (const key of [
  "localStorage",
  "window",
  "document",
  "customElements",
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "CSSStyleSheet",
  "ShadowRoot",
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { StableMarkdown } = await import("../src/stable-markdown.ts");
const { installMarkdownSanitizer } = await import("../src/markdown-sanitize.ts");
installMarkdownSanitizer();

async function mount(content: string): Promise<InstanceType<typeof StableMarkdown>> {
  const block = new StableMarkdown();
  let layout: Promise<void> | undefined;
  block.addEventListener(
    "qm-content-updating",
    (event) => {
      layout = (event as CustomEvent<Promise<void>>).detail;
    },
    { once: true },
  );
  document.body.append(block);
  block.content = content;
  await block.updateComplete;
  await layout;
  return block;
}

test("rendering works without a global Element constructor", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Element")!;
  Reflect.deleteProperty(globalThis, "Element");
  try {
    const block = await mount("A **formatted** reply");
    assert.equal(block.querySelector("strong")?.textContent, "formatted");
    block.content += " with more text";
    await block.updateComplete;
    assert.match(block.textContent!, /with more text/);
    block.remove();
  } finally {
    Object.defineProperty(globalThis, "Element", descriptor);
  }
});

test("a failed render releases its layout notification and can render again", async (t) => {
  const block = await mount("Before");
  let completed = false;
  block.addEventListener("qm-content-updating", (event) => {
    void (event as CustomEvent<Promise<void>>).detail.then(() => {
      completed = true;
    });
  });
  const render = t.mock.method(block, "querySelectorAll", () => {
    throw new Error("render failed");
  });
  try {
    assert.throws(() => Reflect.get(block, "update").call(block, new Map()), /render failed/);
    await Promise.resolve();
    assert.equal(completed, true);
    render.mock.restore();
    block.content = "After";
    await block.updateComplete;
    assert.equal(block.textContent?.trim(), "After");
  } finally {
    render.mock.restore();
    block.remove();
  }
});

test("appending text preserves existing paragraphs, formatted nodes and selection", async () => {
  const block = await mount("A **stable phrase** followed by text");
  const paragraph = block.querySelector("p")!;
  const strong = block.querySelector("strong")!;
  const selection = dom.window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(strong);
  selection.removeAllRanges();
  selection.addRange(range);
  block.content += " and more text";
  await block.updateComplete;
  assert.equal(block.querySelector("p"), paragraph);
  assert.equal(block.querySelector("strong"), strong);
  assert.equal(selection.toString(), "stable phrase");
  assert.match(block.textContent!, /and more text/);
  block.remove();
});

test("completed tables and code components remain mounted while the reply grows", async () => {
  const block = await mount("| name | value |\n| --- | --- |\n| alpha | 1 |\n\n```js\nconst x = 1;\n```\n\nNext");
  const table = block.querySelector("table");
  const code = block.querySelector("code-block");
  assert.ok(code);
  await (code as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
  const marker = document.createElement("i");
  code.append(marker);
  code.setAttribute("data-expanded", "true");
  code.classList.add("text-code-collapsible");
  block.content += " paragraph";
  await block.updateComplete;
  assert.equal(block.querySelector("table"), table);
  assert.equal(block.querySelector("code-block"), code);
  assert.equal(code.getAttribute("data-expanded"), "true");
  assert.ok(code.classList.contains("text-code-collapsible"));
  assert.ok(marker.isConnected, "a custom element owns its rendered children");
  block.remove();
});

test("reference definitions can update earlier text without segment-boundary drift", async () => {
  const block = await mount("intro ".repeat(350) + "[reference][target]\n\nNext paragraph");
  block.content += "\n\n[target]: https://example.com\n";
  await block.updateComplete;
  assert.equal(block.querySelector("a")?.href, "https://example.com/");
  block.remove();
});

test("replacement text and unsafe links are handled by the existing markdown sanitization", async () => {
  const block = await mount("Long original **reply**");
  block.content = "[unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>";
  await block.updateComplete;
  assert.ok(!block.innerHTML.includes('href="javascript:'));
  assert.equal(block.querySelector("img"), null);
  assert.ok(!block.textContent!.includes("Long original"));
  block.remove();
});

test("selection inside a growing text node survives append-only updates", async () => {
  const el = await mount("a growing paragraph");
  const text = el.querySelector("p")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 9);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  el.content = "a growing paragraph with more words";
  await el.updateComplete;
  assert.equal(selection.toString(), "growing");
  assert.equal(el.querySelector("p")!.firstChild, text);
});

test("live chunks fade only new text and keep earlier animations and selected text", async () => {
  const block = await mount("Existing paragraph");
  const original = block.querySelector("p")!.firstChild!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(original, 0, original, 8);
  block.isStreaming = true;
  block.content += " first chunk";
  await block.updateComplete;
  const first = block.querySelector(".tok-in")!;
  assert.equal(first.textContent, " first chunk");
  assert.equal(selection.toString(), "Existing");
  block.content += " second chunk\n\n**New paragraph**";
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), first);
  assert.deepEqual(
    [...block.querySelectorAll(".tok-in")].map((span) => span.textContent),
    [" first chunk", " second chunk", "New paragraph"],
  );
  assert.equal(block.querySelector("p")!.firstChild, original);
  assert.equal(selection.toString(), "Existing");
  block.remove();
});

test("fade cleanup preserves selection inside incoming text and leaves copy text intact", async () => {
  const block = await mount("Before");
  block.isStreaming = true;
  block.content += " incoming words";
  await block.updateComplete;
  const span = block.querySelector(".tok-in")!;
  const text = span.firstChild!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(text, 1, text, 9);
  span.dispatchEvent(new dom.window.Event("animationend"));
  assert.equal(block.querySelector(".tok-in"), null);
  assert.equal(selection.toString(), "incoming");
  assert.equal(block.querySelector("p")!.textContent, "Before incoming words");
  block.remove();
});

test("history, stream completion, disconnect and rewritten content do not replay fades", async () => {
  const block = await mount("History text");
  assert.equal(block.querySelector(".tok-in"), null);
  block.isStreaming = true;
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), null);
  block.content += " appended";
  await block.updateComplete;
  assert.ok(block.querySelector(".tok-in"));
  block.isStreaming = false;
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), null);
  block.isStreaming = true;
  block.content = "Entirely different **replacement**";
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), null);
  block.content += " live suffix";
  await block.updateComplete;
  assert.ok(block.querySelector(".tok-in"));
  block.remove();
  assert.equal(block.querySelector(".tok-in"), null);
  document.body.append(block);
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), null);
  block.remove();
});

test("reduced motion shows incoming text immediately", async () => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  const block = await mount("Before");
  block.isStreaming = true;
  block.content += " after";
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), null);
  assert.equal(block.querySelector("p")!.textContent, "Before after");
  block.remove();
  Reflect.deleteProperty(window, "matchMedia");
});

test("live markdown formatting and unsafe input retain sanitizer and custom code ownership", async () => {
  const block = await mount("Introduction");
  block.isStreaming = true;
  block.content += "\n\n```js\nlet x = 1;\n```\n\n[unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>";
  await block.updateComplete;
  const code = block.querySelector("code-block")!;
  assert.ok(code);
  assert.equal(code.querySelector(".tok-in"), null);
  assert.equal(block.querySelector("img"), null);
  assert.equal(block.querySelector('[href^="javascript:"]'), null);
  block.content += "\n\nTail";
  await block.updateComplete;
  assert.equal(block.querySelector("code-block"), code);
  block.remove();
});

test("hydrated streaming text is immediately visible and only later appended text fades", async () => {
  const block = new StableMarkdown();
  block.isStreaming = true;
  block.streamingBaseline = "Already **read** this paragraph";
  block.content = block.streamingBaseline;
  document.body.append(block);
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in"), null);
  const strong = block.querySelector("strong");
  block.content += " and now new words";
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in")?.textContent, " and now new words");
  assert.equal(block.querySelector("strong"), strong);
  block.remove();
});

test("a snapshot and new tokens in the first render fade only beyond the hydration baseline", async () => {
  const block = new StableMarkdown();
  block.isStreaming = true;
  block.streamingBaseline = "Existing **formatted** text";
  block.content = block.streamingBaseline + " fresh suffix";
  document.body.append(block);
  await block.updateComplete;
  assert.deepEqual(
    [...block.querySelectorAll(".tok-in")].map((span) => span.textContent),
    [" fresh suffix"],
  );
  block.remove();
});

test("a genuinely new first response chunk still fades without a hydration baseline", async () => {
  const block = new StableMarkdown();
  block.isStreaming = true;
  block.content = "First response";
  document.body.append(block);
  await block.updateComplete;
  assert.equal(block.querySelector(".tok-in")?.textContent, "First response");
  block.remove();
});

test("finished fade text stays mounted across append and completion", async () => {
  const block = await mount("Before");
  block.isStreaming = true;
  block.content += " incoming";
  await block.updateComplete;
  const span = block.querySelector(".tok-in")!;
  const text = span.firstChild!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(text, 1, text, 5);
  span.dispatchEvent(new dom.window.Event("animationend"));
  assert.equal(text.parentNode, span);
  assert.ok(span.isConnected);
  assert.equal(selection.toString(), "inco");
  block.content += " more";
  await block.updateComplete;
  assert.equal(span.firstChild, text);
  assert.ok(span.isConnected);
  block.isStreaming = false;
  await block.updateComplete;
  assert.equal(span.firstChild, text);
  assert.ok(span.isConnected);
  assert.equal(selection.toString(), "inco");
  block.remove();
});

test("whitespace chunks preserve text offsets and settled spans", async () => {
  const block = await mount("One");
  block.isStreaming = true;
  let first: Element | null = null;
  for (const chunk of [" ", "two", " ", "three", " and **four**", " five"]) {
    block.content += chunk;
    await block.updateComplete;
    first ??= block.querySelector(".stream-chunk");
    if (first) assert.ok(first.isConnected);
    for (const span of block.querySelectorAll(".tok-in")) span.dispatchEvent(new dom.window.Event("animationend"));
  }
  assert.equal(block.querySelector("p")?.textContent, "One two three and four five");
  block.remove();
});

test("Markdown updates announce their synchronous DOM mutation boundary", async () => {
  const block = await mount("Before");
  const observed: string[] = [];
  const before = () => observed.push(`before:${block.textContent?.trim()}`);
  const after = () => observed.push(`after:${block.textContent?.trim()}`);
  document.body.addEventListener("qm-content-updating", before);
  document.body.addEventListener("qm-content-updated", after);
  try {
    block.content = "After";
    await block.updateComplete;
    assert.deepEqual(observed, ["before:Before", "after:After"]);
  } finally {
    document.body.removeEventListener("qm-content-updating", before);
    document.body.removeEventListener("qm-content-updated", after);
    block.remove();
  }
});

test("Markdown completes its layout boundary after nested code finishes rendering", async () => {
  const block = await mount("```ts\nconst before = 1;\n```");
  const code = block.querySelector("code-block") as HTMLElement & { updateComplete: Promise<unknown> };
  await code.updateComplete;
  await Promise.resolve();
  const observed: string[] = [];
  const done = Promise.withResolvers<void>();
  const after = () => {
    observed.push(code.textContent ?? "");
    done.resolve();
  };
  block.addEventListener("qm-content-updated", after);
  try {
    block.content = "```ts\nconst after = 2;\n```";
    await block.updateComplete;
    await done.promise;
    assert.ok(observed.length >= 1);
    assert.match(observed.at(-1)!, /const after = 2;/);
  } finally {
    block.removeEventListener("qm-content-updated", after);
    block.remove();
  }
});

for (const fence of ["```", "~~~", "````"]) {
  test(`streaming ${fence} fences retain raw code characters before and after closure`, async () => {
    const source = 'type Item<T> = { value: T };\nconst html = "<img src=x onerror=alert(1)> &lt;literal&gt;";';
    const block = await mount(`${fence}typescript\n${source}`);
    const code = block.querySelector("code-block") as HTMLElement & {
      getDecodedCode(): string;
      updateComplete: Promise<unknown>;
    };
    assert.ok(code);
    assert.equal(code.getDecodedCode(), `${source}\n`);
    assert.equal(block.querySelector("img"), null);
    block.content += `\n${fence}`;
    await block.updateComplete;
    await code.updateComplete;
    assert.equal(block.querySelector("code-block"), code);
    assert.equal(code.getDecodedCode(), `${source}\n`);
    block.remove();
  });
}

test("a streamed table never exposes its incomplete header or separator as raw text", async () => {
  const block = await mount("Before\n\n");
  block.isStreaming = true;
  const header = "| Command | Output |\n| --- | --- |";
  for (let length = 1; length <= header.length; length++) {
    block.content = `Before\n\n${header.slice(0, length)}`;
    await block.updateComplete;
    assert.doesNotMatch(block.textContent ?? "", /\|/, `prefix ${length}`);
  }
  assert.deepEqual(
    [...block.querySelectorAll("th")].map((cell) => cell.textContent),
    ["Command", "Output"],
  );
  const table = block.querySelector("table");
  block.content += "\n| alpha | a";
  await block.updateComplete;
  assert.equal(block.querySelector("table"), table);
  assert.deepEqual(
    [...block.querySelectorAll("td")].map((cell) => cell.textContent),
    ["alpha", "a"],
  );
  block.remove();
});

for (const [prefix, linePrefix] of [
  ["Before\n\n", ""],
  ["> Before\n>\n", "> "],
  ["- Before\n\n", "  "],
] as const) {
  test(`incomplete tables preserve preceding content inside ${JSON.stringify(linePrefix)}`, async () => {
    const block = await mount(prefix);
    block.isStreaming = true;
    const source = `${linePrefix}| A | B |\n${linePrefix}| --- | --- |`;
    for (let length = 1; length <= source.length; length++) {
      block.content = prefix + source.slice(0, length);
      await block.updateComplete;
      assert.match(block.textContent ?? "", /Before/);
      assert.doesNotMatch(block.textContent ?? "", /\|/, `prefix ${length}`);
    }
    assert.equal(block.querySelectorAll("th").length, 2);
    block.remove();
  });
}

test("alignment markers and borderless table headers settle without raw separators", async () => {
  const block = await mount("");
  block.isStreaming = true;
  const source = "**Left** | Right\r\n:--- | ---:";
  for (let length = 1; length <= source.length; length++) {
    block.content = source.slice(0, length);
    await block.updateComplete;
    assert.doesNotMatch(block.textContent ?? "", /\||---/, `prefix ${length}`);
  }
  assert.deepEqual(
    [...block.querySelectorAll("th")].map((cell) => cell.textContent),
    ["Left", "Right"],
  );
  assert.equal(block.content, source);
  block.remove();
});

test("pipe prose resumes unchanged when a following line rules out a table", async () => {
  const block = await mount("Before\n\n");
  block.isStreaming = true;
  block.content = "Before\n\nA | B";
  await block.updateComplete;
  block.content += "\nThis is ordinary prose.";
  await block.updateComplete;
  assert.match(block.textContent ?? "", /A \| B\s+This is ordinary prose\./);
  assert.equal(block.querySelector("table"), null);
  block.remove();
});

for (const [source, ending] of [
  ["Before\n\nA | B", "\n\n"],
  ["Before\r\n\r\nA | B", "\r\n \t\r\n"],
  ["> Before\n>\n> A | B", "\n>\n> "],
  ["- Before\n\n  A | B", "\n  \n  "],
] as const) {
  test(`a completed pipe paragraph becomes visible before streaming ends: ${JSON.stringify(ending)}`, async () => {
    const block = await mount("");
    block.isStreaming = true;
    block.content = source;
    await block.updateComplete;
    assert.doesNotMatch(block.textContent ?? "", /A \| B/);
    block.content += ending;
    await block.updateComplete;
    assert.match(block.textContent ?? "", /A \| B/);
    assert.equal(block.querySelector("table"), null);
    assert.equal(block.isStreaming, true);
    block.remove();
  });
}

test("literal pipe text is restored when streaming ends and code pipes stay visible", async () => {
  const block = await mount("Before\n\n");
  block.isStreaming = true;
  block.content = "Before\n\n| literal pipe text";
  await block.updateComplete;
  assert.equal(block.textContent?.trim(), "Before");
  block.isStreaming = false;
  await block.updateComplete;
  assert.match(block.textContent ?? "", /\| literal pipe text/);
  block.isStreaming = true;
  for (const content of ["Use `a | b`", "Use a \\| b", "```text\n| A | B |\n|---|"]) {
    block.content = content;
    await block.updateComplete;
    const code = block.querySelector("code-block") as (HTMLElement & { updateComplete: Promise<unknown> }) | null;
    await code?.updateComplete;
    assert.match(block.textContent ?? "", /\|/);
  }
  block.remove();
});

test("literal HTML remains inert while code and autolinks retain Markdown semantics", async () => {
  const block = await mount(
    "<script>alert(1)</script>\n\nA <strong>literal</strong> tag, ``<T> `code` &lt;literal&gt;``, and <https://example.test/>.",
  );
  assert.equal(block.querySelector("script, strong"), null);
  assert.match(block.textContent!, /<script>alert\(1\)<\/script>/);
  assert.match(block.textContent!, /<strong>literal<\/strong>/);
  assert.equal(block.querySelector("code")?.textContent, "<T> `code` &lt;literal&gt;");
  assert.equal(block.querySelector("a")?.href, "https://example.test/");
  block.remove();
});

test("Mermaid fences become diagrams while other code remains code", async () => {
  const block = await mount("```mermaid\nflowchart LR\nA-->B\n```\n\n```js\nconst x = 1\n```");
  assert.equal(block.querySelector("qm-mermaid")?.getAttribute("code")?.trimEnd(), "flowchart LR\nA-->B");
  assert.equal(block.querySelectorAll("code-block").length, 1);
  block.remove();
});

test("streaming Mermaid keeps source and preserves the component on completion", async () => {
  const block = new StableMarkdown();
  block.isStreaming = true;
  block.content = "```mermaid\nflowchart LR\nA-->";
  document.body.append(block);
  await block.updateComplete;
  const diagram = block.querySelector("qm-mermaid")!;
  assert.ok(diagram.hasAttribute("pending"));
  block.content += "B\n```";
  await block.updateComplete;
  assert.equal(block.querySelector("qm-mermaid"), diagram);
  assert.equal(diagram.getAttribute("code")?.trimEnd(), "flowchart LR\nA-->B");
  block.isStreaming = false;
  await block.updateComplete;
  assert.equal(block.querySelector("qm-mermaid"), diagram);
  assert.equal(diagram.hasAttribute("pending"), false);
  block.remove();
});

test("Mermaid image metadata is rejected before rendering can fetch a URL", async () => {
  const { renderMermaid } = await import("../src/mermaid-block.ts");
  for (const metadata of [
    'img: "/api/private.png", label: "Image", h: 60',
    '"img": "https://example.com/track.png", label: "Image", h: 60',
  ]) {
    const staging = document.createElement("div");
    document.body.append(staging);
    await assert.rejects(
      renderMermaid(`flowchart LR\nA@{ ${metadata} }`, "image-test", staging),
      /Images are not supported/,
    );
    assert.equal(staging.childElementCount, 0);
    staging.remove();
  }
});

test("oversized Mermaid sources are rejected before parsing", async () => {
  const { renderMermaid } = await import("../src/mermaid-block.ts");
  await assert.rejects(
    renderMermaid("A".repeat(50001), "large-test", document.createElement("div")),
    /Diagram is too large/,
  );
});

test("fade ranges preserve selected text across many formatted nodes and paragraphs", async () => {
  const block = await mount("Before");
  block.isStreaming = true;
  block.content += " first **bold** word\n\nSecond _italic_ line\n\nThird";
  await block.updateComplete;
  const oldSpans = [...block.querySelectorAll(".tok-in")];
  const selected = block.querySelector("strong .stream-chunk")!.firstChild!;
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(selected, 0, selected, 4);
  for (const span of oldSpans) span.dispatchEvent(new dom.window.Event("animationend"));
  block.content += " tail\n\nFourth **new** paragraph";
  await block.updateComplete;
  assert.equal(selection.toString(), "bold");
  assert.ok(oldSpans.every((span) => span.isConnected));
  assert.deepEqual(
    [...block.querySelectorAll(".tok-in")].map((span) => span.textContent),
    [" tail", "Fourth ", "new", " paragraph"],
  );
  assert.deepEqual(
    [...block.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
    ["Before first bold word", "Second italic line", "Third tail", "Fourth new paragraph"],
  );
  block.remove();
});
