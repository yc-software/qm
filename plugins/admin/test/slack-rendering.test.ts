import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = html.slice(
  html.indexOf("      function slackUnescape("),
  html.indexOf("      function slackAuthorLabel("),
);

class RenderNode {
  children: RenderNode[] = [];
  value = "";
  href?: string;
  target?: string;
  rel?: string;
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(node: RenderNode) {
    this.children.push(node);
    return node;
  }
  set textContent(value: string) {
    this.value = value;
    this.children = [];
  }
  get textContent(): string {
    return this.value + this.children.map((node) => node.textContent).join("");
  }
  find(tag: string): RenderNode[] {
    return [...(this.tag === tag ? [this] : []), ...this.children.flatMap((node) => node.find(tag))];
  }
}

function render(text: string) {
  const context = vm.createContext({
    SLACK_EMOJI: { wave: "👋" },
    document: {
      createElement: (tag: string) => new RenderNode(tag),
      createDocumentFragment: () => new RenderNode("fragment"),
      createTextNode: (value: string) => {
        const node = new RenderNode("text");
        node.textContent = value;
        return node;
      },
    },
    text,
  });
  vm.runInContext(source, context);
  return vm.runInContext('slackParseText(text, { UEXAMPLE: "Alex" })', context) as RenderNode;
}

test("Slack messages format quotes, safe links, and mentions without dropping prose", () => {
  const result = render(
    "Before\n> First quoted line\n&gt; Second quoted line\nAfter <@UEXAMPLE> :wave:\nhttps://example.com/report.",
  );
  assert.equal(result.find("blockquote").length, 1);
  assert.equal(result.find("blockquote")[0].textContent, "First quoted line\nSecond quoted line");
  assert.match(result.textContent, /^Before/);
  assert.match(result.textContent, /After @Alex 👋\nhttps:\/\/example.com\/report\.$/);
  const [link] = result.find("a");
  assert.equal(link.href, "https://example.com/report");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener");
});

test("Slack message content cannot create executable elements or unsafe links", () => {
  const result = render(
    "<javascript:alert(1)|unsafe> <img src=x onerror=alert(1)> &lt;script&gt;\n```\n> quoted code https://example.com\n```\n`https://example.com/inline`",
  );
  assert.equal(result.find("a").length, 0);
  assert.equal(result.find("script").length, 0);
  assert.equal(result.find("img").length, 0);
  assert.equal(result.find("blockquote").length, 0);
  assert.equal(result.find("pre")[0].textContent, "> quoted code https://example.com");
  assert.equal(result.find("code")[1].textContent, "https://example.com/inline");
  assert.match(result.textContent, /unsafe/);
});

test("Slack links exclude surrounding punctuation and preserve parentheses inside a URL", () => {
  const result = render("See (https://example.com/report). Also https://example.com/wiki/Example_(topic).");
  assert.deepEqual(
    result.find("a").map((node) => node.href),
    ["https://example.com/report", "https://example.com/wiki/Example_(topic)"],
  );
  assert.equal(result.textContent, "See (https://example.com/report). Also https://example.com/wiki/Example_(topic).");
});

test("Slack inline markup preserves emphasis, named links, and prose", () => {
  const result = render("Before *bold* _italic_ ~removed~ <https://example.com|Named link> after");
  assert.equal(result.find("strong")[0].textContent, "bold");
  assert.equal(result.find("em")[0].textContent, "italic");
  assert.equal(result.find("s")[0].textContent, "removed");
  assert.equal(result.find("a")[0].textContent, "Named link");
  assert.equal(result.textContent, "Before bold italic removed Named link after");
});
