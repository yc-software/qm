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

test("prefixes GitHub pull request links with the GitHub mark", () => {
  for (const url of [
    "https://github.com/yc-software/qm/pull/2848",
    "https://github.com/yc-software/qm/pull/2848/files",
    "https://github.com/yc-software/qm/pull/2848#issuecomment-1",
    'https://github.com/yc-software/qm/pull/2848 "a>b"',
  ]) {
    const link = render(`See [PR #2848](${url}).`).querySelector("a")!;
    assert.equal(link.firstElementChild?.getAttribute("class"), "github-pr-mark", url);
    assert.equal(link.textContent, "PR #2848", url);
  }
});

test("leaves other links alone", () => {
  for (const url of [
    "https://github.com/yc-software/qm",
    "https://github.com/yc-software/qm/issues/12",
    "https://github.com/yc-software/qm/pull/abc",
    "https://gitlab.com/yc-software/code/-/merge_requests/1",
    "https://example.com/?u=https://github.com/a/b/pull/1",
  ]) {
    assert.equal(render(`[x](${url})`).querySelector(".github-pr-mark"), null, url);
  }
});
