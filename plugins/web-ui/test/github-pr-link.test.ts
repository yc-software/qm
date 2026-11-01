import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import { decorateGitHubPrLinks } from "../src/github-pr-link.ts";
import { MARKDOWN_SANITIZE_CONFIG } from "../src/markdown-sanitize.ts";

const DOMPurify = createDOMPurify(new JSDOM("").window as unknown as Window & typeof globalThis);
const render = (md: string): string =>
  DOMPurify.sanitize(decorateGitHubPrLinks(marked.parse(md, { async: false })), MARKDOWN_SANITIZE_CONFIG) as string;

test("prefixes GitHub pull request links with the GitHub mark", () => {
  for (const url of [
    "https://github.com/yc-software/qm/pull/2848",
    "https://github.com/yc-software/qm/pull/2848/files",
    "https://github.com/yc-software/qm/pull/2848#issuecomment-1",
  ]) {
    const out = render(`See [PR #2848](${url}).`);
    assert.match(out, /<a href="[^"]+"><svg class="github-pr-mark"[^>]*>.*<\/svg>PR #2848<\/a>/, out);
  }
});

test("leaves other links alone", () => {
  for (const url of [
    "https://github.com/yc-software/qm",
    "https://github.com/yc-software/qm/issues/12",
    "https://gitlab.com/yc-software/code/-/merge_requests/1",
    "https://example.com/?u=https://github.com/a/b/pull/1",
  ]) {
    assert.doesNotMatch(render(`[x](${url})`), /github-pr-mark/, url);
  }
});
