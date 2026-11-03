import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
for (const key of ["window", "document", "Element", "Node"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
const { marked } = await import("marked");
const { installMarkdownSanitizer } = await import("../src/markdown-sanitize.ts");
installMarkdownSanitizer();

const render = (md: string): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = marked.parse(md, { async: false });
  return host;
};

test("prefixes github.com links with the GitHub mark", () => {
  for (const url of [
    "https://github.com/yc-software/qm/pull/2848",
    "https://github.com/yc-software/qm/pull/2848/files",
    "https://github.com/yc-software/qm/pull/2848#issuecomment-1",
    'https://github.com/yc-software/qm/pull/2848 "a>b"',
    "https://github.com/yc-software/qm",
    "https://github.com/yc-software/qm/issues/12",
    "https://github.com/yc-software/qm/blob/main/README.md",
    "https://www.github.com/evebouf",
  ]) {
    const link = render(`See [the link](${url}).`).querySelector("a")!;
    assert.equal(link.firstElementChild?.getAttribute("class"), "github-mark", url);
    assert.equal(link.textContent, "the link", url);
  }
});

test("marks bare github.com URLs", () => {
  const link = render("See https://github.com/yc-software/qm/pull/2848").querySelector("a")!;
  assert.equal(link.firstElementChild?.getAttribute("class"), "github-mark");
});

test("leaves other links alone", () => {
  for (const url of [
    "https://gitlab.com/yc-software/code/-/merge_requests/1",
    "https://gist.github.com/someone/abc",
    "https://github.com.example.com/a/b",
    "https://example.com/?u=https://github.com/a/b/pull/1",
  ]) {
    assert.equal(render(`[x](${url})`).querySelector(".github-mark"), null, url);
  }
});
